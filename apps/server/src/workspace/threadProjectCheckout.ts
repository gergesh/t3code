import {
  CommandId,
  VcsContinueInProjectCheckoutError,
  type ThreadId,
  type VcsContinueInProjectCheckoutInput,
  type VcsMergeWorktreeInput,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * Moves a thread whose worktree is gone into the project checkout, with a notice its agent reads
 * on its next turn. A merge command deletes the worktree on purpose; a manual merge or a deleted
 * folder leaves the thread unable to start a turn until it moves.
 */
export const makeThreadProjectCheckout = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;

  const moveToProjectCheckout = Effect.fn("threadProjectCheckout.move")(function* (input: {
    readonly threadId: ThreadId;
    readonly worktreePath: string;
    readonly projectRoot: string;
    readonly reason: string;
  }) {
    const branch = yield* gitWorkflow
      .currentBranch(input.projectRoot)
      .pipe(Effect.orElseSucceed(() => null));
    yield* threadManagement.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`server:project-checkout:${yield* random.uuidV4()}`),
      threadId: input.threadId,
      branch,
      worktreePath: null,
      expectedWorktreePath: input.worktreePath,
      notice: `${input.reason} This thread now works in the project checkout at ${input.projectRoot}${branch === null ? "" : ` (${branch})`}.`,
    });
  });

  const mergeWorktree = Effect.fn("threadProjectCheckout.mergeWorktree")(function* (
    input: VcsMergeWorktreeInput,
  ) {
    yield* gitWorkflow.mergeWorktree(input);
    if (input.threadId === undefined) return;
    yield* moveToProjectCheckout({
      threadId: input.threadId,
      worktreePath: input.path,
      projectRoot: input.cwd,
      reason: `Merged ${input.branch} and removed its worktree at ${input.path}.`,
    }).pipe(
      // The merge already landed, so a thread that cannot move is not a merge failure.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not move the merged thread to the project checkout", { cause }),
      ),
    );
  });

  const continueInProjectCheckout = Effect.fn("threadProjectCheckout.continueInProjectCheckout")(
    function* (input: VcsContinueInProjectCheckoutInput) {
      const fail = (detail: string) =>
        new VcsContinueInProjectCheckoutError({ threadId: input.threadId, detail });
      const thread = yield* threadManagement
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError((cause) => fail(`Could not read the thread: ${cause.message}`)));
      if (thread === null || thread.worktreePath !== input.worktreePath) {
        return yield* fail("This thread is no longer in that worktree.");
      }
      // Same rule as turn start: anything but a missing path or a non-directory counts as present.
      const present = yield* fileSystem.stat(input.worktreePath).pipe(
        Effect.map((stat) => stat.type === "Directory"),
        Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
      );
      if (present) {
        return yield* fail(`The worktree folder still exists at ${input.worktreePath}.`);
      }
      const project = yield* projects.getById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => fail(`Could not read the project: ${cause.message}`)),
      );
      if (project === undefined) return yield* fail("This thread's project no longer exists.");
      yield* moveToProjectCheckout({
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        projectRoot: project.workspaceRoot,
        reason: `The worktree at ${input.worktreePath} no longer exists.`,
      }).pipe(
        Effect.mapError((cause) =>
          fail(`Could not move the thread to the project checkout: ${cause.message}`),
        ),
      );
    },
  );

  return { mergeWorktree, continueInProjectCheckout };
});
