import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as JjProcess from "./JjProcess.ts";
import * as VcsProcess from "./VcsProcess.ts";

/**
 * The floor is the version every command, revset and template in the jj lane was verified against.
 * Lowering it requires a CI job that runs the jj suite against the new floor binary
 * (`.github/actions/setup-jj` takes a `version` input), not a guess about which release first
 * shipped `json()`, `stringify()` or `bookmark track --remote=`.
 */
const JJ_MINIMUM_VERSION = "0.46.0";

export type JjAvailability =
  | { readonly _tag: "available"; readonly version: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "broken"; readonly detail: string }
  | { readonly _tag: "unsupported-version"; readonly version: string };

const VERSION_PATTERN = /^jj (\d+)\.(\d+)\.(\d+)/;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 4_096;
const UNUSABLE_PROBE_TTL_MS = 30_000;
const USABLE_PROBE_TTL_MS = 5 * 60_000;
const EXECUTABLE_RESOLUTION_TTL_MS = 30_000;
const PROBE_FAILURE_DETAILS: Readonly<Record<string, string>> = {
  VcsProcessSpawnError: "jj could not be executed",
  VcsProcessTimeoutError: "jj did not respond within 5 seconds",
  VcsProcessOutputLimitError: "jj returned too much version output",
};

// Discovery and the driver share a process service, but own separate probe lifetimes.
const invalidationVersions = new WeakMap<VcsProcess.VcsProcess["Service"], number>();

/** Makes the driver's next availability read re-probe after a Settings environment rescan. */
export function invalidateJjAvailability(process: VcsProcess.VcsProcess["Service"]): void {
  invalidationVersions.set(process, (invalidationVersions.get(process) ?? 0) + 1);
}

interface CachedAvailability {
  readonly availability: JjAvailability;
  readonly expiresAt: number;
  readonly invalidationVersion: number;
  readonly executableIdentity: string | null;
}

/**
 * Reads `major.minor.patch` out of a `jj --version` banner, ignoring the `-<hash>` suffix a source
 * build prints. `null` when the output is not a jj version banner at all.
 */
export function parseJjVersion(versionOutput: string): string | null {
  const line = versionOutput.split(/\r?\n/g).find((candidate) => candidate.trim().length > 0);
  const match = line === undefined ? null : VERSION_PATTERN.exec(line.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function versionParts(version: string): ReadonlyArray<number> {
  return version.split(".").map((part) => Number(part));
}

/** Whether a version parsed by {@link parseJjVersion} meets {@link JJ_MINIMUM_VERSION}. */
export function isJjVersionSupported(version: string): boolean {
  const observed = versionParts(version);
  const required = versionParts(JJ_MINIMUM_VERSION);
  for (let index = 0; index < required.length; index += 1) {
    const left = observed[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}

/** Rechecks binary identity on reads; TTLs also cover config and wrapper changes. */
export const makeJjAvailability = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  let executableResolution:
    | {
        readonly path: string;
        readonly searchPath: string;
        readonly expiresAt: number;
        readonly invalidationVersion: number;
      }
    | undefined;
  const executableIdentity = Effect.fn("JjAvailability.executableIdentity")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const searchPath = `${environment.PATH ?? environment.Path ?? environment.path ?? ""}\0${environment.PATHEXT ?? ""}`;
    const invalidationVersion = invalidationVersions.get(process) ?? 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (
        executableResolution === undefined ||
        executableResolution.searchPath !== searchPath ||
        executableResolution.expiresAt <= now ||
        executableResolution.invalidationVersion !== invalidationVersion
      ) {
        const path = resolveExecutable("jj", platform, environment);
        executableResolution =
          path === undefined
            ? undefined
            : {
                path,
                searchPath,
                expiresAt: now + EXECUTABLE_RESOLUTION_TTL_MS,
                invalidationVersion,
              };
      }
      if (executableResolution === undefined) return null;
      const identity = yield* Effect.all({
        resolved: fileSystem.realPath(executableResolution.path),
        info: fileSystem.stat(executableResolution.path),
      }).pipe(
        Effect.map(
          ({ resolved, info }) =>
            `${resolved}\0${Option.getOrUndefined(info.mtime)?.getTime()}\0${info.size}\0${Option.getOrUndefined(info.ino)}`,
        ),
        Effect.orElseSucceed(() => null),
      );
      if (identity !== null) return identity;
      // A removed executable may have exposed a later PATH candidate.
      executableResolution = undefined;
    }
    return null;
  });
  const cached = yield* Ref.make(new Map<string, CachedAvailability>());
  const probeLock = yield* Semaphore.make(1);

  const readCached = Effect.fn("JjAvailability.readCached")(function* (
    cwd: string,
    identity: string | null,
  ) {
    const known = Option.fromUndefinedOr((yield* Ref.get(cached)).get(cwd));
    const now = yield* Clock.currentTimeMillis;
    return Option.filter(
      known,
      (entry) =>
        entry.expiresAt > now &&
        entry.executableIdentity === identity &&
        entry.invalidationVersion === (invalidationVersions.get(process) ?? 0),
    );
  });
  const probe = Effect.fn("JjAvailability.probe")(function* (cwd: string) {
    const result = yield* JjProcess.jjCommand(process, "JjAvailability.probe", cwd, ["--version"], {
      allowNonZeroExit: true,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
    }).pipe(Effect.catch((error) => Effect.succeed(error)));

    if ("_tag" in result) {
      if (
        result._tag === "VcsProcessSpawnError" &&
        ((result.cause instanceof PlatformError.PlatformError &&
          result.cause.reason._tag === "NotFound") ||
          (typeof result.cause === "object" &&
            result.cause !== null &&
            "code" in result.cause &&
            result.cause.code === "ENOENT"))
      ) {
        return { _tag: "missing" } as const;
      }
      return {
        _tag: "broken",
        detail: PROBE_FAILURE_DETAILS[result._tag] ?? "jj version could not be read",
      } as const;
    }
    if (result.exitCode !== 0) {
      return {
        _tag: "broken",
        detail: result.stderr.trim() || "Jujutsu version probe failed.",
      } as const;
    }

    const version = parseJjVersion(result.stdout);
    if (version === null) {
      return {
        _tag: "broken",
        detail: result.stderr.trim() || "Jujutsu version probe returned an invalid version banner.",
      } as const;
    }

    return isJjVersionSupported(version)
      ? ({ _tag: "available", version } as const)
      : ({ _tag: "unsupported-version", version } as const);
  });

  return Effect.fn("JjAvailability.availability")(function* (
    cwd: string,
  ): Effect.fn.Return<JjAvailability, never> {
    const identity = yield* executableIdentity();
    const known = yield* readCached(cwd, identity);
    if (Option.isSome(known)) {
      return known.value.availability;
    }

    return yield* probeLock.withPermits(1)(
      Effect.gen(function* () {
        const raced = yield* readCached(cwd, identity);
        if (Option.isSome(raced)) {
          return raced.value.availability;
        }
        const invalidationVersion = invalidationVersions.get(process) ?? 0;
        const availability = yield* probe(cwd);
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(cached, (entries) => {
          const next = new Map(entries);
          next.delete(cwd);
          if (next.size >= 64) {
            const oldest = next.keys().next();
            if (!oldest.done) next.delete(oldest.value);
          }
          next.set(cwd, {
            availability,
            expiresAt:
              now +
              (availability._tag === "available" ? USABLE_PROBE_TTL_MS : UNUSABLE_PROBE_TTL_MS),
            invalidationVersion,
            executableIdentity: identity,
          });
          return next;
        });
        return availability;
      }),
    );
  });
});

export function jjBrokenReason(detail: string): string {
  const diagnostic = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^(Warning|Hint):/.test(line));
  return `Jujutsu could not run: ${(diagnostic ?? "jj could not be executed").replace(/\.+$/, "")}.`;
}

export const JJ_LINKED_GIT_WORKTREE_UNSUPPORTED_REASON =
  "Jujutsu inside a Git linked worktree is not supported.";

/** The user-facing string that lands in `VcsStatusLocalResult.vcs.unsupportedReason`. */
export function jjUnsupportedReason(input: {
  readonly availability: JjAvailability;
  readonly colocated: boolean;
}): string | null {
  if (!input.colocated) {
    const colocationReason =
      "T3 Code supports colocated Jujutsu repositories. Run `jj git colocation enable` in this repository, or open its Git checkout instead.";
    return input.availability._tag === "missing"
      ? `${colocationReason} Jujutsu was not found on the server’s PATH. Install jj, then rescan in Settings → Source Control.`
      : colocationReason;
  }
  if (input.availability._tag === "broken") {
    return jjBrokenReason(input.availability.detail);
  }
  if (input.availability._tag === "missing") {
    return "Jujutsu was not found on the server’s PATH. Install jj, then rescan in Settings → Source Control.";
  }
  if (input.availability._tag === "unsupported-version") {
    return `Jujutsu ${input.availability.version} is older than the supported minimum ${JJ_MINIMUM_VERSION}. Upgrade jj to use this repository in T3 Code.`;
  }
  return null;
}
