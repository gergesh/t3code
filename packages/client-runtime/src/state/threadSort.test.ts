import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedMove,
  planPinnedReorder,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByLatestMessage,
  sortSettledThreads,
  sortThreads,
  type SettledThreadTimestampInput,
  type ThreadSortInput,
} from "./threadSort.ts";

type TestThread = { readonly id: string } & ThreadSortInput;

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("resolveSettledThreadTimestamp", () => {
  it("prefers the persisted settlement stamp over later activity", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "2026-03-09T10:00:00.000Z",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestRun: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the latest activity when the stamp is missing or malformed", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "invalid",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestRun: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T11:00:00.000Z");
    expect(
      resolveSettledThreadTimestamp({
        settledAt: null,
        latestUserMessageAt: null,
        latestRun: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T12:00:00.000Z");
  });
});

describe("sortSettledThreads", () => {
  const settled = (input: {
    id: string;
    settledAt?: string | null;
    latestUserMessageAt?: string | null;
    latestRun?: SettledThreadTimestampInput["latestRun"];
    updatedAt?: string;
  }) => ({
    id: input.id,
    settledAt: input.settledAt ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestRun: input.latestRun ?? null,
    updatedAt: input.updatedAt ?? "2026-03-09T09:00:00.000Z",
  });

  it("counts a turn completion as activity for auto-settled threads", () => {
    const sorted = sortSettledThreads([
      settled({ id: "message-only", latestUserMessageAt: "2026-03-09T10:04:00.000Z" }),
      settled({
        id: "completed-later",
        latestUserMessageAt: "2026-03-09T10:00:00.000Z",
        latestRun: {
          runId: RunId.make("run-1"),
          status: "completed",
          assistantMessageId: null,
          requestedAt: "2026-03-09T10:00:00.000Z",
          startedAt: "2026-03-09T10:00:00.000Z",
          completedAt: "2026-03-09T10:30:00.000Z",
        },
      }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["completed-later", "message-only"]);
  });

  it("breaks timestamp ties by id so the order is stable", () => {
    const sorted = sortSettledThreads([
      settled({ id: "b", settledAt: "2026-03-09T10:00:00.000Z" }),
      settled({ id: "a", settledAt: "2026-03-09T10:00:00.000Z" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("sortThreads", () => {
  it.each(["created_at", "updated_at"] as const)(
    "preserves references, input order and descending id ties for %s",
    (sortOrder) => {
      const threads = Object.freeze([
        makeThread({ id: "a" }),
        makeThread({ id: "z" }),
        makeThread({ id: "invalid-a", createdAt: "invalid", updatedAt: "invalid" }),
        makeThread({ id: "invalid-z", createdAt: "invalid", updatedAt: "invalid" }),
      ]);
      const sorted = sortThreads(threads, sortOrder);
      expect(sorted).toEqual([threads[1], threads[0], threads[3], threads[2]]);
      expect(sorted[0]).toBe(threads[1]);
      expect(threads[0]?.id).toBe("a");
    },
  );

  it("falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "not-a-date",
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          latestUserMessageAt: "still-not-a-date",
          createdAt: "invalid-created-at",
          updatedAt: "invalid-updated-at",
        }),
        makeThread({
          id: "thread-3",
          latestUserMessageAt: "invalid-latest-user-message-at",
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "invalid-updated-at",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-3", "thread-1", "thread-2"]);
  });

  it("falls back to the latest valid user message when latestUserMessageAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "invalid-latest-user-message-at",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            { role: "user", createdAt: "2026-03-09T10:05:00.000Z" },
            { role: "assistant", createdAt: "2026-03-09T10:30:00.000Z" },
            { role: "user", createdAt: "2026-03-09T10:20:00.000Z" },
          ],
        }),
        makeThread({
          id: "thread-2",
          createdAt: "2026-03-09T10:15:00.000Z",
          updatedAt: "2026-03-09T10:15:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  });
});

describe("planPinnedReorder with hidden rows", () => {
  it("keeps hidden slots available when inserting between visible neighbors", () => {
    const midpoint = pinOrderKeyBetween("f", "t")!;
    const keysById = new Map([
      ["a", "f"],
      ["b", "t"],
      ["moved", "z"],
      ["snoozed", midpoint],
    ]);
    const assignments = planPinnedReorder({
      orderedIds: ["a", "moved", "b"],
      keysById,
      movedId: "moved",
    });
    expect(assignments).toHaveLength(1);
    const key = assignments[0]!.orderKey;
    expect(key > "f" && key < "t").toBe(true);
    expect(key).not.toBe(midpoint);
    expect(assignments[0]!.id).toBe("moved");
  });

  it("materializes keyless rows without overwriting hidden slots", () => {
    const reserved = generateSpreadPinOrderKeys(6);
    const keysById = new Map<string, string | null>([
      ["a", null],
      ["b", null],
      ["c", null],
      ...reserved.map((key, i) => [`hidden-${i}`, key] as const),
    ]);
    const assignments = planPinnedReorder({ orderedIds: ["c", "a", "b"], keysById, movedId: "c" });
    expect(assignments.map(({ id }) => id)).toEqual(["c", "a", "b"]);
    const keys = assignments.map(({ orderKey }) => orderKey);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((key) => !reserved.includes(key))).toBe(true);
  });
});

describe("generateSpreadPinOrderKeys", () => {
  it.each([0, 1, 650, 675, 676, 1_001, 2_000])(
    "leaves unique, insertable keys for %i threads",
    (count) => {
      const keys = generateSpreadPinOrderKeys(count);
      expect(keys).toHaveLength(count);
      expect(new Set(keys).size).toBe(count);
      expect([...keys].sort()).toEqual(keys);
      for (let index = 0; index < keys.length; index += 1) {
        const before = keys[index - 1] ?? null;
        const after = keys[index]!;
        expect(after).toMatch(/^[a-z]*[b-z]$/);
        const between = pinOrderKeyBetween(before, after);
        expect(between).not.toBeNull();
        expect(between! < after).toBe(true);
        if (before !== null) expect(between! > before).toBe(true);
      }
    },
  );
});

describe("sortActiveThreadsByLatestMessage", () => {
  it("puts the thread the user last wrote in first, ignoring saved order", () => {
    const sorted = sortActiveThreadsByLatestMessage([
      {
        id: "new-quiet",
        createdAt: "2026-03-09T11:00:00.000Z",
        latestUserAuthoredMessageAt: "2026-03-09T11:00:00.000Z",
      },
      {
        id: "old-busy",
        createdAt: "2026-03-01T09:00:00.000Z",
        latestUserAuthoredMessageAt: "2026-03-09T12:00:00.000Z",
        activeOrderKey: "t",
      },
      {
        id: "untouched",
        createdAt: "2026-03-09T10:00:00.000Z",
        latestUserAuthoredMessageAt: null,
      },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["old-busy", "new-quiet", "untouched"]);
  });

  it("ignores wakes and agent messages unless the server predates authored stamps", () => {
    const threads = [
      {
        id: "woken",
        createdAt: "2026-03-09T09:00:00.000Z",
        latestUserMessageAt: "2026-03-09T13:00:00.000Z",
        latestUserAuthoredMessageAt: "2026-03-09T09:00:00.000Z",
      },
      {
        id: "written",
        createdAt: "2026-03-09T09:00:00.000Z",
        latestUserMessageAt: "2026-03-09T12:00:00.000Z",
        latestUserAuthoredMessageAt: "2026-03-09T12:00:00.000Z",
      },
    ];
    expect(sortActiveThreadsByLatestMessage(threads).map((thread) => thread.id)).toEqual([
      "written",
      "woken",
    ]);
    expect(
      sortActiveThreadsByLatestMessage(
        threads.map(({ latestUserAuthoredMessageAt: _, ...thread }) => thread),
      ).map((thread) => thread.id),
    ).toEqual(["woken", "written"]);
  });

  it("lifts a thread reopened from settled", () => {
    const sorted = sortActiveThreadsByLatestMessage([
      {
        id: "recent",
        createdAt: "2026-03-09T09:00:00.000Z",
        latestUserAuthoredMessageAt: "2026-03-09T11:00:00.000Z",
      },
      {
        id: "reopened",
        createdAt: "2026-03-01T09:00:00.000Z",
        latestUserAuthoredMessageAt: "2026-03-02T09:00:00.000Z",
        unsettledAt: "2026-03-09T12:00:00.000Z",
      },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["reopened", "recent"]);
  });

  it("breaks equal timestamps by thread then environment", () => {
    const threads = [
      { id: "thread-b", environmentId: "env-a" },
      { id: "thread-a", environmentId: "env-b" },
      { id: "thread-a", environmentId: "env-a" },
    ].map((thread) => ({ ...thread, createdAt: "2026-03-09T10:00:00.000Z" }));
    expect(
      sortActiveThreadsByLatestMessage(threads).map(
        (thread) => `${thread.id}:${thread.environmentId}`,
      ),
    ).toEqual(["thread-a:env-a", "thread-a:env-b", "thread-b:env-a"]);
  });
});

describe("planPinnedMove", () => {
  it("moves a keyless thread into the arranged run with one write", () => {
    const assignments = planPinnedMove({
      orderedIds: ["new", "reopened", "first", "last"],
      keysById: new Map([
        ["new", null],
        ["reopened", null],
        ["first", "f"],
        ["last", "t"],
      ]),
      movedId: "reopened",
      direction: "down",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe("reopened");
    expect(assignments![0]!.orderKey > "f").toBe(true);
    expect(assignments![0]!.orderKey < "t").toBe(true);
  });
});
