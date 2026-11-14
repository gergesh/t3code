import { ProviderDriverKind, type UsageLimitSourceAccount } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { soonestResetPriorities } from "./hubRoutingPriorities.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const inDays = (days: number) => iso(NOW + days * 86_400_000);
const weekly = (usedPercent: number, resetsAt?: string) => ({
  id: "seven_day",
  kind: "weekly" as const,
  label: "Weekly",
  windowDurationMins: 7 * 24 * 60,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});
const session = (usedPercent: number, resetsAt: string) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  windowDurationMins: 5 * 60,
  usedPercent,
  resetsAt,
});
const account = (
  id: string,
  windows: UsageLimitSourceAccount["usageLimits"]["windows"],
  driver = claude,
): UsageLimitSourceAccount => ({
  id,
  driver,
  usageLimits: { checkedAt: iso(NOW), windows },
});

describe("soonestResetPriorities", () => {
  it("ranks accounts by when their weekly quota expires, not by how much is left", () => {
    const priorities = soonestResetPriorities(
      [
        account("later-mostly-unused", [weekly(10, inDays(2))]),
        account("soon-nearly-spent", [weekly(95, inDays(0.05))]),
        account("latest", [weekly(50, inDays(5))]),
        account("last", [weekly(50, inDays(6))]),
      ],
      NOW,
    );
    expect(Object.fromEntries(priorities)).toEqual({
      "soon-nearly-spent": 4,
      "later-mostly-unused": 3,
      latest: 2,
      last: 1,
    });
  });

  it("orders by the outer window and only lets an inner window take an account out", () => {
    const priorities = soonestResetPriorities(
      [
        // Its session resets first, but its weekly quota expires after the other account's.
        account("session-soon", [session(20, inDays(0.1)), weekly(30, inDays(4))]),
        account("weekly-soon", [session(20, inDays(0.2)), weekly(30, inDays(1))]),
        account("session-spent", [session(100, inDays(0.1)), weekly(10, inDays(0.5))]),
      ],
      NOW,
    );
    expect(Object.fromEntries(priorities)).toEqual({
      "weekly-soon": 2,
      "session-soon": 1,
      "session-spent": 0,
    });
  });

  it("puts not-yet-started, spent and unreadable accounts behind started ones", () => {
    const priorities = soonestResetPriorities(
      [
        account("fresh-b", [weekly(0)]),
        account("fresh-a", [weekly(0)]),
        account("spent", [weekly(100, inDays(1))]),
        {
          ...account("unreadable", []),
          usageLimits: {
            checkedAt: iso(NOW),
            windows: [],
            unavailable: { reason: "probeFailed" },
          },
        },
        account("started", [weekly(40, inDays(3))]),
      ],
      NOW,
    );
    expect(Object.fromEntries(priorities)).toEqual({
      started: 3,
      "fresh-a": 2,
      "fresh-b": 1,
      spent: 0,
      unreadable: 0,
    });
  });

  it("ignores spend caps and model-scoped allowances, and ranks each provider on its own", () => {
    const priorities = soonestResetPriorities(
      [
        account("claude-a", [
          weekly(20, inDays(3)),
          { ...weekly(100, inDays(0.5)), id: "seven_day_fable", label: "Weekly · Fable" },
          { id: "spend", kind: "monthly", label: "Spend", usedPercent: 100, resetsAt: inDays(1) },
        ]),
        account("codex-a", [weekly(20, inDays(4))], codex),
      ],
      NOW,
    );
    expect(Object.fromEntries(priorities)).toEqual({ "claude-a": 1, "codex-a": 1 });
  });
});
