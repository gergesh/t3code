import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";

/** The renderer loads its native library through `node:ffi`, new in Node 26.4. */
const MINIMUM_NODE = [26, 4] as const;

/**
 * Packages a plain Node needs to run `t3 tui` from a copied bundle, beyond the bundle itself:
 * the externals the CLI loads at startup and the renderer. Their dependencies come along.
 */
const RELAUNCH_PACKAGES = ["@opentui/core", "diff", "undici"] as const;

const RELAUNCHED_ENV = "T3CODE_TUI_RELAUNCHED";

export class TuiRuntimeError extends Schema.TaggedError<TuiRuntimeError>()("TuiRuntimeError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

// A variable specifier: the Node type definitions do not declare `node:ffi` yet.
const FFI_MODULE: string = "node:ffi";

export const hasFfi = Effect.promise(() =>
  import(FFI_MODULE).then(
    () => true,
    () => false,
  ),
);

const PackageManifest = Schema.Struct({
  version: Schema.optional(Schema.String),
  t3codeCommitHash: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));

/** A `node` on PATH new enough for the renderer, or null. */
const findCapableNode = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({ command: "node", args: ["-p", "process.versions.node"], timeout: "10 seconds" })
    .pipe(Effect.option);
  if (result._tag === "None" || result.value.code !== 0) return null;
  const [major = 0, minor = 0] = result.value.stdout.trim().split(".").map(Number);
  const [needMajor, needMinor] = MINIMUM_NODE;
  return major > needMajor || (major === needMajor && minor >= needMinor) ? "node" : null;
});

/**
 * The desktop app keeps the CLI inside its ASAR archive, which only Electron can read.
 * Copies the bundle and the packages it needs to a folder a plain Node can run, once per build.
 */
const extractFromArchive = Effect.fn("cli.tui.extractFromArchive")(function* (
  distDir: string,
  t3Home: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appRoot = path.resolve(distDir, "../../..");
  const app = yield* fileSystem
    .readFileString(path.join(appRoot, "package.json"))
    .pipe(Effect.flatMap(decodeManifest));
  const target = path.join(
    t3Home,
    "cache",
    "tui-runtime",
    `${app.version ?? "unknown"}-${app.t3codeCommitHash ?? "unknown"}`,
  );
  // Electron answers `access` with ENOENT inside an ASAR, which `exists` relies on; `stat` works.
  const present = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const ready = path.join(target, ".ready");
  if (yield* present(ready)) return path.join(target, "dist", "bin.mjs");

  yield* fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore);
  // Electron reads ASAR entries through `fs`, file by file, so the copy walks the tree itself.
  const copyTree: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError> =
    Effect.fnUntraced(function* (from, to) {
      const info = yield* fileSystem.stat(from);
      if (info.type === "Directory") {
        yield* fileSystem.makeDirectory(to, { recursive: true });
        for (const entry of yield* fileSystem.readDirectory(from)) {
          yield* copyTree(path.join(from, entry), path.join(to, entry));
        }
        return;
      }
      yield* fileSystem.writeFile(to, yield* fileSystem.readFile(from));
    });

  yield* fileSystem.makeDirectory(path.join(target, "dist"), { recursive: true });
  // The bundle's code only; the web client and source maps are most of its size.
  for (const entry of yield* fileSystem.readDirectory(distDir)) {
    if (entry.endsWith(".mjs") || entry.endsWith(".json")) {
      yield* copyTree(path.join(distDir, entry), path.join(target, "dist", entry));
    }
  }
  const pending: string[] = [...RELAUNCH_PACKAGES];
  const copied = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (copied.has(name)) continue;
    copied.add(name);
    const source = path.join(appRoot, "node_modules", name);
    // Optional dependencies for other platforms are not installed.
    if (!(yield* present(source))) continue;
    yield* copyTree(source, path.join(target, "node_modules", name));
    const manifest = yield* fileSystem
      .readFileString(path.join(source, "package.json"))
      .pipe(Effect.flatMap(decodeManifest));
    // Peers too: OpenTUI takes web-tree-sitter as one.
    pending.push(
      ...Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    );
  }
  yield* fileSystem.writeFileString(ready, "");
  return path.join(target, "dist", "bin.mjs");
});

/**
 * Runs `t3 tui` under a Node that has FFI when this one does not, such as the desktop
 * app's Electron, and returns its exit code.
 */
export const relaunchTui = Effect.fn("cli.tui.relaunch")(function* (t3Home: string) {
  if ((yield* HostProcess.Environment)[RELAUNCHED_ENV] === "1") {
    return yield* new TuiRuntimeError({ detail: "t3 tui could not load its terminal renderer." });
  }
  const node = yield* findCapableNode.pipe(Effect.provide(ProcessRunner.layer));
  if (node === null) {
    return yield* new TuiRuntimeError({
      detail: `t3 tui needs Node ${MINIMUM_NODE.join(".")} or newer on your PATH. This t3 runs on Node ${process.versions.node}.`,
    });
  }
  const path = yield* Path.Path;
  const [entryArgument, ...args] = (yield* HostProcess.Arguments).slice(1);
  const entry = path.resolve(entryArgument ?? "");
  const distDir = path.dirname(entry);
  const runnable = distDir.includes(".asar")
    ? yield* extractFromArchive(distDir, t3Home).pipe(
        Effect.mapError(
          (cause) =>
            new TuiRuntimeError({
              detail: `t3 tui could not unpack its files from the app: ${String(cause)}`,
            }),
        ),
      )
    : entry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make(node, [runnable, ...args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        // Stays in the terminal's foreground process group, which alone receives SIGWINCH on resize.
        detached: false,
        extendEnv: true,
        env: { [RELAUNCHED_ENV]: "1", ELECTRON_RUN_AS_NODE: undefined },
      }),
    )
    .pipe(Effect.mapError((cause) => new TuiRuntimeError({ detail: String(cause) })));
});
