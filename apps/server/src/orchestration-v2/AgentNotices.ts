import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The text that tells the agent about notices recorded for it, such as a merged worktree, when
 * `run` is the first run to start since they were recorded. Empty when there are none.
 */
export function agentNoticeText(
  notices: ReadonlyArray<OrchestrationV2TurnItem>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "startedAt">>,
  run: Pick<OrchestrationV2Run, "id" | "ordinal">,
): string {
  const messages = notices.flatMap((notice) => {
    if (notice.type !== "system_notice" || notice.forAgent !== true || notice.startedAt === null)
      return [];
    const recordedAt = notice.startedAt;
    const alreadyTold = runs.some(
      (earlier) =>
        earlier.id !== run.id &&
        earlier.ordinal < run.ordinal &&
        earlier.startedAt !== null &&
        DateTime.isGreaterThan(earlier.startedAt, recordedAt),
    );
    return alreadyTold ? [] : [`- ${notice.message}`];
  });
  return messages.length === 0
    ? ""
    : ["Note: this happened in T3 Code since your last turn:", ...messages].join("\n");
}
