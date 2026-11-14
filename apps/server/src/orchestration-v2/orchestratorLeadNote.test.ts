import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compactionRunOrdinals, latestLeadNote, leadNoteToSend } from "./orchestratorLeadNote.ts";

const runs = [1, 2, 3].map((ordinal) => ({ id: RunId.make(`run-${ordinal}`), ordinal }));
const attempt = (
  ordinal: number,
  leadNote: OrchestrationV2RunAttempt["leadNote"],
  nativeThreadId = "native-a",
): OrchestrationV2RunAttempt => ({
  id: RunAttemptId.make(`attempt-${ordinal}`),
  nativeThreadId,
  ...(leadNote === undefined ? {} : { leadNote }),
  runId: RunId.make(`run-${ordinal}`),
  attemptOrdinal: 1,
  rootNodeId: NodeId.make(`root-${ordinal}`),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  providerTurnId: null,
  reason: "initial",
  status: "completed",
  startedAt: null,
  completedAt: null,
});

describe("leadNoteToSend", () => {
  it.each([
    { name: "first orchestrator turn", orchestrating: true, attempts: [], expected: "on" },
    {
      name: "lead note already in this conversation",
      orchestrating: true,
      attempts: [attempt(1, "on"), attempt(2, undefined)],
      expected: undefined,
    },
    {
      name: "new native conversation (provider switch, /clear)",
      orchestrating: true,
      attempts: [attempt(1, "on", "native-old")],
      expected: "on",
    },
    {
      name: "compaction since the note",
      orchestrating: true,
      attempts: [attempt(1, "on")],
      compactedRuns: ["run-2"],
      expected: "on",
    },
    {
      name: "compaction in the run that sent it",
      orchestrating: true,
      attempts: [attempt(1, "on")],
      compactedRuns: ["run-1"],
      expected: "on",
    },
    {
      name: "compaction before the note",
      orchestrating: true,
      attempts: [attempt(2, "on")],
      compactedRuns: ["run-1"],
      expected: undefined,
    },
    {
      name: "prompt the provider never accepted",
      orchestrating: true,
      attempts: [attempt(1, "on")],
      accepted: [],
      expected: "on",
    },
    {
      name: "turned back on after off",
      orchestrating: true,
      attempts: [attempt(1, "on"), attempt(2, "off")],
      expected: "on",
    },
    {
      name: "turned off",
      orchestrating: false,
      attempts: [attempt(1, "on")],
      expected: "off",
    },
    {
      name: "off already sent",
      orchestrating: false,
      attempts: [attempt(1, "on"), attempt(2, "off")],
      expected: undefined,
    },
    {
      name: "turned off after compaction dropped the note",
      orchestrating: false,
      attempts: [attempt(1, "on")],
      compactedRuns: ["run-2"],
      expected: undefined,
    },
    { name: "never orchestrated", orchestrating: false, attempts: [], expected: undefined },
  ] as const)("$name", ({ orchestrating, attempts, expected, ...input }) => {
    const accepted =
      "accepted" in input ? input.accepted : attempts.map((candidate) => candidate.id);
    const latest = latestLeadNote({
      nativeThreadId: "native-a",
      runs,
      attempts,
      providerTurns: accepted.map((runAttemptId) => ({ runAttemptId })),
    });
    const compacted = "compactedRuns" in input ? input.compactedRuns : [];
    expect(
      leadNoteToSend({
        orchestrating,
        latest,
        compactionRunOrdinals: compactionRunOrdinals(
          runs,
          compacted.map((id) => RunId.make(id)),
        ),
      }),
    ).toBe(expected);
  });
});
