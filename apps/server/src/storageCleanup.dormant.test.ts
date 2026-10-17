import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import { describeJj, runJj } from "./vcs/testing/JjTestSupport.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

const detection = vi.hoisted(() => ({
  kind: null as "git" | null,
  observed: undefined as "git" | null | undefined,
}));

vi.mock("./vcs/VcsDriverRegistry.ts", async (importOriginal) => {
  const registry = await importOriginal<typeof VcsDriverRegistry>();
  // vi.mock factories run before static imports initialize; load these inside the factory.
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const GitVcsDriver = await import("./vcs/GitVcsDriver.ts");
  return {
    ...registry,
    layer: Layer.effect(
      registry.VcsDriverRegistry,
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.makeVcsDriver;
        return {
          detect: ({ cwd }: VcsDriverRegistry.VcsDriverResolveInput) =>
            (detection.kind === null
              ? Effect.succeed(null)
              : driver
                  .detectRepository(cwd)
                  .pipe(
                    Effect.map((repository) =>
                      repository === null ? null : { kind: "git" as const, repository, driver },
                    ),
                  )
            ).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  detection.observed = handle?.kind ?? null;
                }),
              ),
            ),
          get: () => Effect.die("Non-jj cleanup must not resolve a driver"),
          resolve: () => Effect.die("Non-jj cleanup must not resolve a driver"),
        };
      }),
    ),
  };
});

describeJj("non-jj detection metadata preservation", () => {
  it.live.each([null, "git"] as const)("keeps jj metadata when detection returns %s", (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        detection.kind = kind;
        detection.observed = undefined;
        const fixture = yield* cleanupFixture();
        yield* runJj(fixture.worktree, ["git", "init", "--colocate"]);
        const report = yield* fixture.service.runNow;
        expect(detection.observed).toBe(kind);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("Jujutsu"),
        });
        expect(yield* fixture.fs.exists(`${fixture.worktree}/.jj`)).toBe(true);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "original\n",
        );
      }),
    ),
  );
});
