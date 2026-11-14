import { ProviderInstanceId } from "@t3tools/contracts";
import type { ResolveWorkspace, WorkspaceResolution } from "@t3tools/tui";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { hasFfi, relaunchTui, TuiRuntimeError } from "./tuiRelaunch.ts";
import {
  locateProjectByPath,
  reportThreadErrors,
  ThreadServerNotRunningError,
  ThreadUsageError,
} from "./thread.ts";

// Revoked on exit; the expiry only bounds a session left behind by a killed terminal.
const SESSION_TTL = Duration.days(7);

const isTuiRuntimeError = Schema.is(TuiRuntimeError);

const continueFlag = Flag.Boolean("continue").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Reopen the latest thread in this directory instead of starting one."),
  Flag.withDefault(false),
);

/**
 * The renderer runs on Node's experimental FFI, whose warning would print over
 * the terminal before the TUI takes the screen. Other warnings still print.
 */
const quietFfiWarning = Effect.acquireRelease(
  Effect.sync(() => {
    const emitWarning = process.emitWarning;
    process.emitWarning = function (this: unknown, ...args: Parameters<typeof emitWarning>) {
      const [warning, options] = args;
      const type = typeof options === "string" ? options : options?.type;
      const message = typeof warning === "string" ? warning : warning.message;
      if (type === "ExperimentalWarning" && message.includes("FFI")) return;
      return Reflect.apply(emitWarning, process, args);
    } as typeof emitWarning;
    return emitWarning;
  }),
  (emitWarning) => Effect.sync(() => void (process.emitWarning = emitWarning)),
);

const workspaceResolver = Effect.fn("cli.tui.workspaceResolver")(function* (cwd: string) {
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const resolve: ResolveWorkspace = (projects) =>
    locateProjectByPath(projects, cwd, { exact: true }).pipe(
      Effect.map(({ project, worktree }): WorkspaceResolution => ({
        projectId: project.id,
        worktreePath: worktree,
      })),
      Effect.catchTags({
        ThreadProjectNotFoundError: () =>
          Effect.succeed<WorkspaceResolution>({ projectId: null, worktreePath: null }),
      }),
      Effect.orDie,
      Effect.provideContext(services),
    );
  return resolve;
});

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Provider instance id for a new thread. Pass with --model."),
  Flag.optional,
);

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("Model slug for a new thread. Defaults to the project's default model."),
  Flag.optional,
);

export const tuiCommand = Command.make("tui", {
  ...authLocationFlags,
  continue: continueFlag,
  provider: providerFlag,
  model: modelFlag,
}).pipe(
  Command.withDescription("Chat with an agent in this directory, in the terminal."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
      }
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      // Before the probe below, which prints the warning when FFI exists.
      yield* quietFfiWarning;
      // The desktop app's `t3` runs on Electron's Node, which has no FFI for the renderer.
      if (!(yield* hasFfi)) {
        const code = yield* relaunchTui(config.baseDir);
        if (code !== 0) process.exitCode = code;
        return;
      }
      const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* new ThreadServerNotRunningError({ baseDir: config.baseDir });
      }
      const workingDirectory = yield* HostProcess.WorkingDirectory;
      const cwd = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) => fileSystem.realPath(workingDirectory)),
        Effect.orElseSucceed(() => workingDirectory),
      );
      const resolveWorkspace = yield* workspaceResolver(cwd);
      yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* Effect.acquireRelease(
          environmentAuth.issueSession({ label: "t3 tui", ttl: SESSION_TTL }),
          (session) => environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore),
        );
        // Deferred so other commands never load the renderer's native library.
        const { runTui } = yield* Effect.promise(() => import("@t3tools/tui"));
        yield* runTui({
          server: { httpBaseUrl: runtimeState.value.origin, bearerToken: issued.token },
          cwd,
          resume: flags.continue,
          modelSelection:
            Option.isSome(flags.provider) && Option.isSome(flags.model)
              ? {
                  instanceId: ProviderInstanceId.make(flags.provider.value),
                  model: flags.model.value,
                }
              : null,
          resolveWorkspace,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
      );
    }).pipe(
      Effect.scoped,
      reportThreadErrors,
      Effect.tapError((error) =>
        isTuiRuntimeError(error) ? Console.error(error.message) : Effect.void,
      ),
    ),
  ),
);
