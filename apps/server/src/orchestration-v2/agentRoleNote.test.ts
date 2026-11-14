import { describe, expect, it } from "@effect/vitest";

import type { OrchestrationV2RunAttempt, RunAttemptId, RunId } from "@t3tools/contracts";

import { latestRoleNote, ROLE_NOTE_OFF, roleNoteToSend } from "./agentRoleNote.ts";

const runId = (ordinal: number) => `run-${ordinal}` as RunId;
const attempt = (
  ordinal: number,
  roleNote: string | undefined,
  nativeThreadId = "native-1",
): OrchestrationV2RunAttempt =>
  ({
    id: `attempt-${ordinal}` as RunAttemptId,
    runId: runId(ordinal),
    attemptOrdinal: 1,
    nativeThreadId,
    ...(roleNote === undefined ? {} : { roleNote }),
  }) as OrchestrationV2RunAttempt;

describe("latestRoleNote", () => {
  it("takes the newest accepted note in the same native conversation", () => {
    const attempts = [
      attempt(1, "engineer:aaaa"),
      attempt(2, "engineer:bbbb"),
      attempt(3, "qa:cccc", "native-2"),
      attempt(4, "qa:dddd"),
    ];
    const latest = latestRoleNote({
      nativeThreadId: "native-1",
      runs: [1, 2, 3, 4].map((ordinal) => ({ id: runId(ordinal), ordinal })),
      attempts,
      // Run 4's prompt never reached the provider.
      providerTurns: attempts.slice(0, 3).map((candidate) => ({ runAttemptId: candidate.id })),
    });
    expect(latest).toMatchObject({ note: "engineer:bbbb", runOrdinal: 2 });
  });
});

describe("roleNoteToSend", () => {
  const brief = { note: "engineer:aaaa", runOrdinal: 2 };
  it.each([
    ["a new conversation gets the brief", "engineer:aaaa", undefined, [], "engineer:aaaa"],
    ["a brief in context is not repeated", "engineer:aaaa", brief, [], undefined],
    ["an edited file sends the brief again", "engineer:bbbb", brief, [], "engineer:bbbb"],
    ["a compaction may have dropped it", "engineer:aaaa", brief, [3], "engineer:aaaa"],
    ["an earlier compaction did not", "engineer:aaaa", brief, [1], undefined],
    ["a removed role sends the ended note", undefined, brief, [], ROLE_NOTE_OFF],
    ["the ended note goes once", undefined, { note: ROLE_NOTE_OFF, runOrdinal: 3 }, [], undefined],
    ["no role and nothing sent stays quiet", undefined, undefined, [], undefined],
  ] as const)("%s", (_name, desired, latest, compactions, expected) => {
    expect(roleNoteToSend({ desired, latest, compactionRunOrdinals: compactions })).toBe(expected);
  });
});
