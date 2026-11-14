import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";

type LeadNote = NonNullable<OrchestrationV2RunAttempt["leadNote"]>;

/** The note the provider accepted last in this native conversation, with its run's ordinal. */
export function latestLeadNote(input: {
  readonly nativeThreadId: string | undefined;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
}): { readonly note: LeadNote; readonly runOrdinal: number } | undefined {
  if (input.nativeThreadId === undefined) return undefined;
  const accepted = new Set(input.providerTurns.map((turn) => turn.runAttemptId));
  const ordinals = new Map(input.runs.map((run) => [run.id, run.ordinal]));
  let latest: { note: LeadNote; runOrdinal: number; attemptOrdinal: number } | undefined;
  for (const attempt of input.attempts) {
    const runOrdinal = ordinals.get(attempt.runId);
    if (
      attempt.leadNote === undefined ||
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
      latest = { note: attempt.leadNote, runOrdinal, attemptOrdinal: attempt.attemptOrdinal };
    }
  }
  return latest;
}

/**
 * Lead instructions go once per native conversation, again after a compaction that may have
 * dropped them, and an "off" note follows them when the mode ends.
 */
export function leadNoteToSend(input: {
  readonly orchestrating: boolean;
  readonly latest: ReturnType<typeof latestLeadNote>;
  /** Ordinals of runs with a compaction item; only needed when the latest note is "on". */
  readonly compactionRunOrdinals: ReadonlyArray<number>;
}): LeadNote | undefined {
  const latest = input.latest;
  const leadInContext =
    latest?.note === "on" &&
    !input.compactionRunOrdinals.some((ordinal) => ordinal >= latest.runOrdinal);
  if (input.orchestrating) return leadInContext ? undefined : "on";
  return leadInContext ? "off" : undefined;
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
