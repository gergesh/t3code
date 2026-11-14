import type {
  FilesystemListFrecentDirectoriesResult,
  FrecentDirectorySource,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const MAX_DIRECTORIES = 100;
// Stale and file entries are dropped after ranking, so stat a few times the cap.
const MAX_CANDIDATES = MAX_DIRECTORIES * 4;
const STAT_CONCURRENCY = 16;
const MAX_DATA_FILE_BYTES = 4 * 1024 * 1024;
const ZOXIDE_TIMEOUT = "2 seconds";

interface ScoredPath {
  readonly path: string;
  readonly score: number;
}

export class FrecentDirectories extends Context.Service<
  FrecentDirectories,
  {
    /** Never fails: a missing tool, unreadable data, or a timeout yields an empty list. */
    readonly list: () => Effect.Effect<FilesystemListFrecentDirectoriesResult>;
  }
>()("t3/workspace/FrecentDirectories") {}

// fasd's weighting; z and z.lua differ only in the constants, not the order they produce.
function recencyWeight(ageSeconds: number): number {
  if (ageSeconds < 3_600) return 6;
  if (ageSeconds < 86_400) return 4;
  if (ageSeconds < 604_800) return 2;
  return 1;
}

/** fasd, z, zsh-z and z.lua all store `path|rank|epochSeconds` lines. */
function parseRankTimeData(text: string, nowSeconds: number): ScoredPath[] {
  const totals = new Map<string, { rank: number; time: number }>();
  for (const line of text.split("\n")) {
    // Split from the right: the path itself may contain `|`.
    const timeSeparator = line.lastIndexOf("|");
    const rankSeparator = line.lastIndexOf("|", timeSeparator - 1);
    if (rankSeparator <= 0) continue;
    const path = line.slice(0, rankSeparator);
    const rank = Number(line.slice(rankSeparator + 1, timeSeparator));
    const time = Number(line.slice(timeSeparator + 1));
    if (!Number.isFinite(rank) || !Number.isFinite(time)) continue;
    const existing = totals.get(path);
    totals.set(
      path,
      existing === undefined
        ? { rank, time }
        : { rank: existing.rank + rank, time: Math.max(existing.time, time) },
    );
  }
  return Array.from(totals, ([path, { rank, time }]) => ({
    path,
    score: rank * recencyWeight(nowSeconds - time),
  }));
}

/** `zoxide query --list --score` prints `  <score> <path>` lines. */
function parseZoxideList(text: string): ScoredPath[] {
  const entries: ScoredPath[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+(?:\.\d+)?)\s(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    entries.push({ path: match[2], score: Number(match[1]) });
  }
  return entries;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const readZoxide = processRunner
    .run({
      command: "zoxide",
      args: ["query", "--list", "--score"],
      timeout: ZOXIDE_TIMEOUT,
      maxOutputBytes: MAX_DATA_FILE_BYTES,
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((output) => (output.code === 0 ? parseZoxideList(output.stdout) : [])),
      Effect.orElseSucceed((): ScoredPath[] => []),
    );

  // Shells keep `_FASD_DATA`/`_Z_DATA` unexported, so check every default location and trust
  // the most recently written file; a stale legacy file can sit beside the live one.
  const readFreshestDataFile = Effect.fnUntraced(function* (
    candidates: ReadonlyArray<string | undefined>,
  ) {
    let freshest: { readonly file: string; readonly mtime: number } | null = null;
    for (const file of new Set(candidates)) {
      if (file === undefined || file.length === 0) continue;
      const info = yield* fileSystem.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      if (Number(info.value.size) > MAX_DATA_FILE_BYTES) continue;
      const mtime = Option.match(info.value.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      if (freshest === null || mtime > freshest.mtime) freshest = { file, mtime };
    }
    if (freshest === null) return [];
    const text = yield* fileSystem
      .readFileString(freshest.file)
      .pipe(Effect.orElseSucceed(() => ""));
    const nowSeconds = (yield* Clock.currentTimeMillis) / 1_000;
    return parseRankTimeData(text, nowSeconds);
  });

  const readSource = Effect.fnUntraced(function* (source: FrecentDirectorySource) {
    const env = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    switch (source) {
      case "zoxide":
        return yield* readZoxide;
      case "fasd":
        return yield* readFreshestDataFile([
          env._FASD_DATA,
          path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "fasd"),
          path.join(home, ".fasd"),
        ]);
      case "z":
        return yield* readFreshestDataFile([
          env._Z_DATA,
          env.ZSHZ_DATA,
          env._ZL_DATA,
          path.join(home, ".z"),
          path.join(home, ".zlua"),
        ]);
    }
  });

  const isDirectory = (candidate: string) =>
    fileSystem.stat(candidate).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const list = Effect.fn("FrecentDirectories.list")(function* () {
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    // One tool's history is the user's; scores from different tools don't compare.
    for (const source of ["zoxide", "fasd", "z"] as const) {
      const entries = yield* readSource(source);
      const candidates = entries
        .filter(
          (entry) =>
            path.isAbsolute(entry.path) &&
            entry.path !== home &&
            path.dirname(entry.path) !== entry.path,
        )
        .toSorted((left, right) => right.score - left.score)
        .slice(0, MAX_CANDIDATES)
        .map((entry) => entry.path);
      const existing = yield* Effect.forEach(candidates, isDirectory, {
        concurrency: STAT_CONCURRENCY,
      });
      const directories = candidates
        .filter((_, index) => existing[index])
        .slice(0, MAX_DIRECTORIES)
        .map((directory) =>
          platform !== "win32" && directory.startsWith(`${home}/`)
            ? `~/${directory.slice(home.length + 1)}`
            : directory,
        );
      if (directories.length > 0) {
        yield* Effect.annotateCurrentSpan({ source, count: directories.length });
        return { source, directories };
      }
    }
    return { source: null, directories: [] };
  });

  return FrecentDirectories.of({ list });
});

export const layer = Layer.effect(FrecentDirectories, make);
