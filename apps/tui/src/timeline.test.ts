import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { timelineRows } from "./timeline.ts";

type Variant<T extends OrchestrationV2TurnItem["type"]> = Omit<
  Extract<OrchestrationV2TurnItem, { type: T }>,
  keyof typeof base | "id"
>;

const base = {
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as OrchestrationV2TurnItem["status"],
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
};

const item = <T extends OrchestrationV2TurnItem["type"]>(
  id: string,
  fields: Variant<T> & { readonly status?: OrchestrationV2TurnItem["status"] },
) => ({ ...base, ...fields, id: TurnItemId.make(id) }) as OrchestrationV2TurnItem;

const rowsOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  timelineRows({
    visibleTurnItems: items.map((turnItem, position) => ({
      position,
      visibility: "local",
      sourceThreadId: turnItem.threadId,
      sourceItemId: turnItem.id,
      item: turnItem,
    })),
  }).map(({ id, tone, text }) => ({ id, tone, text }));

describe("timelineRows", () => {
  it("shows an interrupt once: the request while it waits, then only the result", () => {
    const request = (status: OrchestrationV2TurnItem["status"]) =>
      item<"run_interrupt_request">("request", {
        type: "run_interrupt_request",
        message: "Stopped by user",
        status,
      });
    const result = item<"run_interrupt_result">("result", {
      type: "run_interrupt_result",
      message: "Stopped by user",
    });
    expect(rowsOf([request("running")])).toEqual([
      { id: "request", tone: "info", text: "Stopped by user" },
    ]);
    expect(rowsOf([request("completed"), result])).toEqual([
      { id: "result", tone: "info", text: "Stopped by user" },
    ]);
  });

  it("names tool calls in one line and leaves out empty reasoning and workspace preparation", () => {
    expect(
      rowsOf([
        item<"reasoning">("thinking", { type: "reasoning", text: "  ", streaming: false }),
        item<"command_execution">("preparation", {
          type: "command_execution",
          input: "Preparing workspace",
          status: "running",
        }),
        item<"command_execution">("command", {
          type: "command_execution",
          input: "vp test run\nexit",
          exitCode: 2,
        }),
        item<"file_change">("edit", {
          type: "file_change",
          fileName: "src/math.ts",
          additions: 4,
          deletions: 1,
        }),
      ]),
    ).toEqual([
      { id: "command", tone: "tool", text: "Run vp test run  exit 2" },
      { id: "edit", tone: "tool", text: "Edit src/math.ts  +4 -1" },
    ]);
  });
});
