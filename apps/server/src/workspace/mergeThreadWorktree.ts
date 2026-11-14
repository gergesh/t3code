import { CommandId, type ThreadId, type VcsMergeWorktreeInput } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Runs the project's worktree merge command. The command deletes the worktree, so the thread that
 * worked there moves to the project checkout, with a notice its agent reads on its next turn.
 */
export const makeMergeThreadWorktree = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;

  const continueInProjectCheckout = Effect.fn("mergeThreadWorktree.continueInProjectCheckout")(
    function* (input: VcsMergeWorktreeInput, threadId: ThreadId) {
      const branch = yield* gitWorkflow
        .currentBranch(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`server:worktree-merge:${yield* random.uuidV4()}`),
        threadId,
        branch,
        worktreePath: null,
        expectedWorktreePath: input.path,
        notice: `Merged ${input.branch} and removed its worktree at ${input.path}. This thread now works in the project checkout at ${input.cwd}${branch === null ? "" : ` (${branch})`}.`,
      });
    },
    // The merge already landed, so a thread that cannot move is not a merge failure.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not move the merged thread to the project checkout", { cause }),
    ),
  );

  return Effect.fn("mergeThreadWorktree")(function* (input: VcsMergeWorktreeInput) {
    yield* gitWorkflow.mergeWorktree(input);
    if (input.threadId !== undefined) yield* continueInProjectCheckout(input, input.threadId);
  });
});
