import { createCliRenderer } from "@opentui/core";
import type { ModelSelection } from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as Deferred from "effect/Deferred";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { readClipboardImage, readImageAttachment } from "./attachments.ts";
import { environmentLayer, type TuiServer } from "./environment.ts";
import { makeSession, type ResolveWorkspace, type Session } from "./session.ts";
import { mountView } from "./view.ts";

export type { TuiServer } from "./environment.ts";
export type { ResolveWorkspace, WorkspaceResolution } from "./session.ts";

export interface RunTuiOptions {
  readonly server: TuiServer;
  readonly cwd: string;
  /** Reopen the latest thread in this directory instead of starting a new one. */
  readonly resume: boolean;
  /** Overrides the project's and the settings' default model for a new thread. */
  readonly modelSelection: ModelSelection | null;
  readonly resolveWorkspace: ResolveWorkspace;
}

/** Work a key press asks for; it runs on a fiber that has the session's services. */
/** What reading images needs from the machine; the CLI that runs the TUI provides it. */
type TuiPlatform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

interface Action {
  readonly run: (session: Session) => Effect.Effect<void, never, TuiPlatform>;
  /** Runs beside the queue, so a stop is never stuck behind a send still waiting on the server. */
  readonly urgent?: boolean;
}

const acquireRenderer = Effect.acquireRelease(
  Effect.promise(() =>
    createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen", useMouse: true }),
  ),
  (renderer) => Effect.sync(() => renderer.destroy()),
);

/** Runs until the user quits; the terminal is restored however it ends. */
export const runTui = Effect.fn("Tui.run")(function* (options: RunTuiOptions) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: options.server.httpBaseUrl,
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const server = {
    ...options.server,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
  };
  return yield* Effect.gen(function* () {
    const renderer = yield* acquireRenderer;
    const exit = yield* Deferred.make<void>();
    // Key handlers run outside Effect, so they hand work to a fiber that has the session's services.
    const actions = yield* Queue.unbounded<Action>();
    const enqueue = (run: Action["run"], urgent = false) =>
      void Queue.offerUnsafe(actions, { run, urgent });
    let session: Session | null = null;
    const view = mountView(renderer, {
      send: (text, attachments, queue) => enqueue((it) => it.send(text, attachments, queue)),
      attachImages: (paths) =>
        enqueue(() =>
          Effect.forEach(paths, (path) => readImageAttachment(path)).pipe(
            Effect.match({
              onFailure: (reason) => view.notify(reason),
              onSuccess: (images) => view.addAttachments(images),
            }),
          ),
        ),
      pasteImage: () =>
        enqueue(() =>
          readClipboardImage().pipe(
            Effect.match({
              onFailure: (reason) => view.notify(reason),
              onSuccess: (image) => view.addAttachments([image]),
            }),
          ),
        ),
      interrupt: () => enqueue((it) => it.interrupt, true),
      answerApproval: (requestId, decision, feedback) =>
        enqueue((it) => it.answerApproval(requestId, decision, feedback)),
      answerQuestion: (requestId, answers) =>
        enqueue((it) => it.answerQuestion(requestId, answers)),
      setModel: (selection) => enqueue((it) => it.setModel(selection)),
      setRuntimeMode: (mode) => enqueue((it) => it.setRuntimeMode(mode)),
      togglePlanMode: () => enqueue((it) => it.togglePlanMode),
      implementPlan: () => enqueue((it) => it.implementPlan),
      newThread: () => enqueue((it) => it.newThread),
      openThread: (id) => enqueue((it) => it.openThread(id)),
      listThreads: () =>
        enqueue((it) =>
          it.listThreads().pipe(
            Effect.flatMap(({ threads, now }) => Effect.sync(() => view.showThreads(threads, now))),
            Effect.ignoreCause,
          ),
        ),
      loadEarlier: () => enqueue((it) => it.loadEarlier),
      manageQueued: (action) => enqueue((it) => it.manageQueued(action)),
      setVerbose: (verbose) => enqueue((it) => it.setVerbose(verbose)),
      models: () => session?.models() ?? [],
      exit: () => Deferred.doneUnsafe(exit, Effect.void),
    });
    // A closed terminal window sends SIGHUP; quitting still restores the TTY and revokes the session.
    const hangUp = () => Deferred.doneUnsafe(exit, Effect.void);
    yield* Effect.acquireRelease(
      Effect.sync(() => process.once("SIGHUP", hangUp)),
      () => Effect.sync(() => process.off("SIGHUP", hangUp)),
    );
    session = yield* makeSession(
      {
        cwd: options.cwd,
        resume: options.resume,
        modelSelection: options.modelSelection,
        resolveWorkspace: options.resolveWorkspace,
      },
      view.render,
    );
    const ready = session;
    yield* Stream.fromQueue(actions).pipe(
      Stream.runForEach((action) =>
        action.urgent ? Effect.forkScoped(action.run(ready)) : action.run(ready),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(exit);
  }).pipe(Effect.scoped, Effect.provide(environmentLayer(server)));
});
