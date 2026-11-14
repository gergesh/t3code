import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { agentNoticeText } from "./AgentNotices.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 14, 12, minute));

const notice = (minute: number, message: string, forAgent = true): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`notice-${minute}`),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: minute,
  status: "completed",
  title: null,
  startedAt: at(minute),
  completedAt: at(minute),
  updatedAt: at(minute),
  type: "system_notice",
  message,
  ...(forAgent ? { forAgent: true } : {}),
});

const run = (
  ordinal: number,
  startedMinute: number | null,
): Pick<OrchestrationV2Run, "id" | "ordinal" | "startedAt"> => ({
  id: RunId.make(`run-${ordinal}`),
  ordinal,
  startedAt: startedMinute === null ? null : at(startedMinute),
});

describe("agentNoticeText", () => {
  const merged = notice(10, "Merged feature and removed its worktree.");

  it("tells the first run that starts after the notice, and only that run", () => {
    const runs = [run(1, 0), run(2, 20), run(3, 30)];
    expect(agentNoticeText([merged], runs, runs[1]!)).toBe(
      "Note: this happened in T3 Code since your last turn:\n- Merged feature and removed its worktree.",
    );
    expect(agentNoticeText([merged], runs, runs[2]!)).toBe("");
  });

  it("still tells a run queued before the notice that starts after it", () => {
    const runs = [run(1, 0), run(2, null), run(3, null)];
    expect(agentNoticeText([merged], runs, runs[1]!)).not.toBe("");
  });

  it("ignores notices meant only for people", () => {
    const runs = [run(1, 0), run(2, null)];
    expect(agentNoticeText([notice(10, "History truncated.", false)], runs, runs[1]!)).toBe("");
  });
});
