import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as FrecentDirectories from "./FrecentDirectories.ts";

const NOW_SECONDS = 1_800_000_000;
const HOUR = 3_600;
const MONTH = 30 * 86_400;

type ZoxideResult = { readonly stdout: string; readonly code: number } | "missing";

const processRunnerLayer = (zoxide: ZoxideResult) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        zoxide === "missing"
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: input.command,
                argumentCount: input.args.length,
                cause: new Error("ENOENT"),
              }),
            )
          : Effect.succeed({
              stdout: zoxide.stdout,
              stderr: "",
              code: zoxide.code as never,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
    }),
  );

/** Lists against a temp home holding `dirs` and `files`. */
const listFrom = Effect.fn(function* (input: {
  readonly dirs: ReadonlyArray<string>;
  /** `[path, contents, mtime?]`; `$HOME` in contents expands to the temp home. */
  readonly files?: ReadonlyArray<readonly [string, string, number?]>;
  readonly env?: (home: string) => NodeJS.ProcessEnv;
  readonly zoxide?: (home: string) => ZoxideResult;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-frecent-" }),
  );
  for (const dir of input.dirs) {
    yield* fileSystem.makeDirectory(path.join(home, dir), { recursive: true });
  }
  for (const [file, contents, mtime] of input.files ?? []) {
    const filePath = path.join(home, file);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents.replaceAll("$HOME", home));
    if (mtime !== undefined) yield* fileSystem.utimes(filePath, mtime, mtime);
  }
  yield* TestClock.setTime(NOW_SECONDS * 1_000);
  const result = yield* Effect.service(FrecentDirectories.FrecentDirectories).pipe(
    Effect.flatMap((service) => service.list()),
    Effect.provide(
      FrecentDirectories.layer.pipe(
        Layer.provide(processRunnerLayer(input.zoxide?.(home) ?? "missing")),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, input.env?.(home) ?? {}),
  );
  return { home, result };
});

const dataLine = (path: string, rank: number, ageSeconds: number) =>
  `${path}|${rank}|${NOW_SECONDS - ageSeconds}`;

describe("FrecentDirectories", () => {
  it.effect("ranks fasd entries by frecency and keeps only existing directories", () =>
    Effect.gen(function* () {
      const { result } = yield* listFrom({
        dirs: ["recent", "old-busy", "dup", "with|pipe"],
        files: [
          ["recent/file.ts", ""],
          [
            ".cache/fasd",
            [
              // 3 * 6 (last hour) beats 10 * 1 (a month ago).
              dataLine("$HOME/recent", 3, 60),
              dataLine("$HOME/old-busy", 10, MONTH),
              // Duplicate lines sum their ranks and keep the newest time: (2 + 2) * 6.
              dataLine("$HOME/dup", 2, MONTH),
              dataLine("$HOME/dup", 2, 60),
              dataLine("$HOME/with|pipe", 1, MONTH),
              dataLine("$HOME/recent/file.ts", 100, 60),
              dataLine("$HOME/deleted", 100, 60),
              dataLine("$HOME", 100, 60),
              dataLine("relative/path", 100, 60),
              "garbage line",
              "",
            ].join("\n"),
          ],
        ],
      });
      expect(result).toEqual({
        source: "fasd",
        directories: ["~/dup", "~/recent", "~/old-busy", "~/with|pipe"],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the most recently written fasd data file", () =>
    Effect.gen(function* () {
      const { result } = yield* listFrom({
        dirs: ["stale", "live"],
        files: [
          // A legacy file an older fasd left behind beside the live XDG one.
          [".fasd", dataLine("$HOME/stale", 50, HOUR), 0],
          [".cache/fasd", dataLine("$HOME/live", 1, HOUR)],
        ],
      });
      expect(result).toEqual({ source: "fasd", directories: ["~/live"] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers zoxide and parses its scored list", () =>
    Effect.gen(function* () {
      const { result } = yield* listFrom({
        dirs: ["a", "b", "from-fasd"],
        files: [[".cache/fasd", dataLine("$HOME/from-fasd", 1, HOUR)]],
        zoxide: (home) => ({
          stdout: `  12.5 ${home}/b\n   4 ${home}/a\n  99 ${home}/gone\n  1 /\n`,
          code: 0,
        }),
      });
      expect(result).toEqual({ source: "zoxide", directories: ["~/b", "~/a"] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls through an empty zoxide to z data named by _Z_DATA", () =>
    Effect.gen(function* () {
      const { result } = yield* listFrom({
        dirs: ["project"],
        files: [["custom/z-data", dataLine("$HOME/project", 1, HOUR)]],
        env: (home) => ({ _Z_DATA: `${home}/custom/z-data` }),
        zoxide: () => ({ stdout: "", code: 1 }),
      });
      expect(result).toEqual({ source: "z", directories: ["~/project"] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns an empty list when no tool has data", () =>
    Effect.gen(function* () {
      const { result } = yield* listFrom({ dirs: [] });
      expect(result).toEqual({ source: null, directories: [] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
