import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import { GitCommandError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorktreeCommands from "../vcs/WorktreeCommands.ts";

/** Only `kind` reaches the Git guard; the rest of the handle never does. */
function handleFor(kind: "git" | "jj"): VcsDriverRegistry.VcsDriverHandle {
  return { kind } as unknown as VcsDriverRegistry.VcsDriverHandle;
}

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly gitManager?: Partial<GitManager.GitManager["Service"]>;
  readonly worktreeCommands?: Partial<WorktreeCommands.WorktreeCommands["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(WorktreeCommands.WorktreeCommands)({
        resolve: () => Effect.succeed({ create: "", remove: "" }),
        ...input.worktreeCommands,
      }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
        ...(input.resolve ? { resolve: input.resolve } : {}),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(input.git ?? {})),
    Layer.provide(Layer.mock(GitManager.GitManager)(input.gitManager ?? {})),
  );
}

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(Layer.mock(WorktreeCommands.WorktreeCommands)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  describe("custom worktree commands", () => {
    const gitStatus = (stdout: string) =>
      Effect.succeed({
        exitCode: 0,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      } as GitVcsDriver.ExecuteGitResult);

    it.effect("hands the create command to the driver as its checkout step", () => {
      const run = vi.fn(
        (_input: Parameters<WorktreeCommands.WorktreeCommands["Service"]["run"]>[0]) =>
          Effect.succeed(""),
      );

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "main",
          newRefName: "t3/feature",
          path: null,
        });

        assert.equal(run.mock.calls.length, 1);
        const [call] = run.mock.calls[0]!;
        assert.equal(call.command, "make-worktree");
        assert.equal(call.projectCwd, "/repo");
        assert.deepStrictEqual(call.env, {
          T3CODE_PROJECT_ROOT: "/repo",
          T3CODE_WORKTREE_PATH: "/worktrees/repo/t3-feature",
          T3CODE_BRANCH: "t3/feature",
          T3CODE_START_REF: "main",
          T3CODE_CREATE_BRANCH: "1",
        });
      }).pipe(
        Effect.provide(
          layer({
            detect: () => Effect.succeed(handleFor("git")),
            resolve: () => Effect.succeed(handleFor("git")),
            gitManager: {
              createWorktree: (_input, options) =>
                (
                  options?.customCheckout?.({
                    worktreePath: "/worktrees/repo/t3-feature",
                    branch: "t3/feature",
                    startRef: "main",
                    createBranch: true,
                  }) ?? Effect.succeed(null)
                ).pipe(
                  Effect.as({
                    worktree: { path: "/worktrees/repo/t3-feature", refName: "t3/feature" },
                  }),
                ),
            },
            worktreeCommands: {
              resolve: () => Effect.succeed({ create: "make-worktree", remove: "" }),
              run,
            },
          }),
        ),
      );
    });

    it.effect("runs the remove command instead of the built-in step and prunes after it", () => {
      const gitRemoveWorktree = vi.fn(() => Effect.void);
      const pruneWorktrees = vi.fn(() => Effect.void);

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        // A child of the scoped temp dir, so the scope's own cleanup survives the removal.
        const worktreePath = `${yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-custom-rm-" })}/worktree`;
        yield* fileSystem.makeDirectory(worktreePath);
        const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
          Effect.provide(
            layer({
              detect: () => Effect.succeed(handleFor("git")),
              resolve: () => Effect.succeed(handleFor("git")),
              git: {
                execute: () => gitStatus(""),
                removeWorktree: gitRemoveWorktree,
                pruneWorktrees,
              },
              worktreeCommands: {
                resolve: () => Effect.succeed({ create: "", remove: "drop-worktree" }),
                run: ({ env }) =>
                  fileSystem
                    .remove(env.T3CODE_WORKTREE_PATH!, { recursive: true })
                    .pipe(Effect.as(""), Effect.orDie),
              },
            }),
          ),
        );

        yield* workflow.removeWorktree({ cwd: "/repo", path: worktreePath });

        assert.equal(gitRemoveWorktree.mock.calls.length, 0);
        assert.equal(pruneWorktrees.mock.calls.length, 1);
      }).pipe(Effect.provide(NodeServices.layer));
    });

    it.effect("refuses to remove a git worktree with changes unless forced", () => {
      const run = vi.fn(() => Effect.succeed(""));

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-custom-rm-" });
        const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
          Effect.provide(
            layer({
              detect: () => Effect.succeed(handleFor("git")),
              resolve: () => Effect.succeed(handleFor("git")),
              git: { execute: () => gitStatus(" M src/index.ts\n") },
              worktreeCommands: {
                resolve: () => Effect.succeed({ create: "", remove: "drop-worktree" }),
                run,
              },
            }),
          ),
        );

        const exit = yield* Effect.exit(
          workflow.removeWorktree({ cwd: "/repo", path: worktreePath }),
        );

        assert.isTrue(Exit.isFailure(exit));
        assert.equal(run.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer));
    });

    it.effect("fails when the remove command leaves the worktree in place", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-custom-rm-" });
        const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
          Effect.provide(
            layer({
              detect: () => Effect.succeed(handleFor("git")),
              resolve: () => Effect.succeed(handleFor("git")),
              worktreeCommands: {
                resolve: () => Effect.succeed({ create: "", remove: "true" }),
                run: () => Effect.succeed(""),
              },
            }),
          ),
        );

        const error = yield* Effect.flip(
          workflow.removeWorktree({ cwd: "/repo", path: worktreePath, force: true }),
        );

        assert.instanceOf(error, GitCommandError);
        expect(error.detail).toContain("left");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
