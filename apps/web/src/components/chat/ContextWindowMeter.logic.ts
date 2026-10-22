import type { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  COMPACTION_SUGGESTION_MIN_TOKENS,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

// Fallback TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

/** When Claude's prompt cache for the latest request expires, or null when unknown. */
export function claudePromptCacheExpiry(input: {
  readonly provider: string | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
}): { readonly expiresAtMs: number; readonly estimated: boolean } | null {
  if (input.provider !== "claudeAgent") return null;
  const updatedAt = Date.parse(input.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) return null;
  return {
    expiresAtMs: updatedAt + (input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS),
    // A request served fully from cache reports no TTL, so the fallback is a guess.
    estimated: input.promptCacheTtlMs === undefined,
  };
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): boolean {
  if ((input.usedTokens ?? 0) < COMPACTION_SUGGESTION_MIN_TOKENS) return false;
  const expiry = claudePromptCacheExpiry(input);
  const now = Date.parse(input.now);
  return expiry !== null && Number.isFinite(now) && now >= expiry.expiresAtMs;
}

function formatMinutes(ms: number, estimated: boolean): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const text =
    minutes < 1
      ? "<1m"
      : hours === 0
        ? `${minutes}m`
        : minutes % 60 === 0
          ? `${hours}h`
          : `${hours}h ${minutes % 60}m`;
  return estimated ? `~${text}` : text;
}

/** Whether the prompt cache is still warm, and how long until or since it expires. */
export function describePromptCache(input: {
  readonly provider: string | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): { readonly warm: boolean; readonly label: string } | null {
  const expiry = claudePromptCacheExpiry(input);
  const now = Date.parse(input.now);
  if (expiry === null || !Number.isFinite(now)) return null;
  const remainingMs = expiry.expiresAtMs - now;
  return remainingMs > 0
    ? {
        warm: true,
        label: `Cache warm, expires in ${formatMinutes(remainingMs, expiry.estimated)}`,
      }
    : { warm: false, label: `Cache expired ${formatMinutes(-remainingMs, expiry.estimated)} ago` };
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
