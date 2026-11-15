import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeThreadProjectCheckout } from "./threadProjectCheckout.ts";

const threadId = ThreadId.make("thread-missing-worktree");
const projectRoot = "/tmp/project-checkout";

const continueIn = (input: { readonly threadWorktree: string; readonly requested: string }) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const checkout = yield* makeThreadProjectCheckout.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                projectId: ProjectId.make("project"),
                worktreePath: input.threadWorktree,
              } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return {} as never;
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: projectRoot } as never),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            currentBranch: () => Effect.succeed("main"),
          }),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(7)),
          ),
        ),
      ),
    );
    const result = yield* Effect.result(
      checkout.continueInProjectCheckout({ threadId, worktreePath: input.requested }),
    );
    return { result, dispatched };
  });

it.layer(NodeServices.layer)("continueInProjectCheckout", (it) => {
  it.effect("moves a thread whose worktree folder is gone to the project checkout", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const gone = `${root}/merged`;
      const { result, dispatched } = yield* continueIn({ threadWorktree: gone, requested: gone });
      assert.strictEqual(result._tag, "Success");
      assert.deepInclude(dispatched[0], {
        type: "thread.metadata.update",
        threadId,
        branch: "main",
        worktreePath: null,
        expectedWorktreePath: gone,
        notice: `The worktree at ${gone} no longer exists. This thread now works in the project checkout at ${projectRoot} (main).`,
      });
    }),
  );

  it.effect("refuses while the folder exists or once the thread has moved", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      for (const input of [
        { threadWorktree: root, requested: root },
        { threadWorktree: `${root}/other`, requested: `${root}/gone` },
      ]) {
        const { result, dispatched } = yield* continueIn(input);
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(dispatched, []);
      }
    }),
  );
});
