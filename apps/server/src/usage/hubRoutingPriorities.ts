import type { ServerProviderUsageWindow, UsageLimitSourceAccount } from "@t3tools/contracts";

import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";

/** The hub's default priority; spent and unreadable accounts share it as the last fallback. */
const BASE_PRIORITY = 0;

// Monthly windows are spend caps, and model-scoped windows block only their own model.
const isQuotaWindow = (window: ServerProviderUsageWindow) =>
  (window.kind === "session" || window.kind === "weekly") && windowLimitsModel(window, null);

const span = (window: ServerProviderUsageWindow) =>
  window.windowDurationMins ?? (window.kind === "weekly" ? 7 * 24 * 60 : 5 * 60);

/**
 * When the account's unused quota expires: the reset of its longest window, since an inner window
 * only paces spending. `Infinity` means its quota has not started a window, so nothing expires yet.
 * `null` means it cannot take traffic now or its usage is unknown.
 */
function expiresAt(account: UsageLimitSourceAccount, now: number): number | null {
  if (account.usageLimits.unavailable) return null;
  const windows = account.usageLimits.windows.filter(isQuotaWindow);
  if (windows.length === 0 || windows.some((window) => window.usedPercent >= 100)) return null;
  const outer = windows.reduce((longest, window) =>
    span(window) > span(longest) ? window : longest,
  );
  const reset = Date.parse(outer.resetsAt ?? "");
  return Number.isFinite(reset) && reset > now ? reset : Number.POSITIVE_INFINITY;
}

/**
 * Hub priorities that spend each provider's accounts strictly earliest-expiry first; the hub uses
 * only the highest priority it can. Accounts that have not started a window come last, ordered by
 * id, so only one fresh window starts at a time.
 */
export function soonestResetPriorities(
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
  now: number,
): ReadonlyMap<string, number> {
  const priorities = new Map<string, number>();
  const pools = Map.groupBy(accounts, (account) => account.driver);
  for (const pool of pools.values()) {
    const ranked = pool
      .flatMap((account) => {
        const expiry = expiresAt(account, now);
        priorities.set(account.id, BASE_PRIORITY);
        return expiry === null ? [] : [{ id: account.id, expiry }];
      })
      .toSorted((a, b) => a.expiry - b.expiry || a.id.localeCompare(b.id));
    ranked.forEach(({ id }, rank) => priorities.set(id, BASE_PRIORITY + ranked.length - rank));
  }
  return priorities;
}
