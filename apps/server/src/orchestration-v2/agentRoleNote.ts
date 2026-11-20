import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";

/** Recorded when the role-ended note is sent; any other value is `<role>:<digest>`. */
export const ROLE_NOTE_OFF = "off";

/** The role note the provider accepted last in this native conversation, with its run's ordinal. */
export function latestRoleNote(input: {
  readonly nativeThreadId: string | undefined;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
}): { readonly note: string; readonly runOrdinal: number } | undefined {
  if (input.nativeThreadId === undefined) return undefined;
  const accepted = new Set(input.providerTurns.map((turn) => turn.runAttemptId));
  const ordinals = new Map(input.runs.map((run) => [run.id, run.ordinal]));
  let latest: { note: string; runOrdinal: number; attemptOrdinal: number } | undefined;
  for (const attempt of input.attempts) {
    const runOrdinal = ordinals.get(attempt.runId);
    if (
      attempt.roleNote === undefined ||
      attempt.nativeThreadId !== input.nativeThreadId ||
      runOrdinal === undefined ||
      !accepted.has(attempt.id)
    )
      continue;
    if (
      latest === undefined ||
      runOrdinal > latest.runOrdinal ||
      (runOrdinal === latest.runOrdinal && attempt.attemptOrdinal > latest.attemptOrdinal)
    ) {
      latest = { note: attempt.roleNote, runOrdinal, attemptOrdinal: attempt.attemptOrdinal };
    }
  }
  return latest;
}

/**
 * A role brief goes once per native conversation, again when the role or its file changes or a
 * compaction may have dropped it, and the ended note follows it when the role is taken away.
 */
export function roleNoteToSend(input: {
  /** `<role>:<digest>` of the brief this thread should be following, or undefined for none. */
  readonly desired: string | undefined;
  readonly latest: ReturnType<typeof latestRoleNote>;
  /** Ordinals of runs with a compaction item; only needed when the latest note is a brief. */
  readonly compactionRunOrdinals: ReadonlyArray<number>;
}): string | undefined {
  const latest = input.latest;
  const briefInContext =
    latest !== undefined &&
    latest.note !== ROLE_NOTE_OFF &&
    !input.compactionRunOrdinals.some((ordinal) => ordinal >= latest.runOrdinal);
  if (input.desired !== undefined) {
    return briefInContext && latest?.note === input.desired ? undefined : input.desired;
  }
  return briefInContext ? ROLE_NOTE_OFF : undefined;
}

export const compactionRunOrdinals = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>,
  compactionRunIds: ReadonlyArray<RunId | null>,
): ReadonlyArray<number> => {
  const ordinals = new Map(runs.map((run) => [run.id, run.ordinal]));
  return compactionRunIds.flatMap((runId) => {
    const ordinal = runId === null ? undefined : ordinals.get(runId);
    return ordinal === undefined ? [] : [ordinal];
  });
};
