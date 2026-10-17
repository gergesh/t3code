import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { getVcsTerminology } from "@t3tools/shared/vcs";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

const NOW = new Date("2026-10-26T12:00:10.000Z");

function snapshot(overrides: Partial<WorktreeSetupSnapshot>): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    branch: "t3/feature",
    baseRef: "main",
    worktreePath: "/repo/.t3/worktrees/feature",
    setupScript: null,
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:03.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "checkout",
        status: "running",
        startedAt: "2026-10-26T12:00:03.000Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
    ...overrides,
  };
}

const card = (value: WorktreeSetupSnapshot, kind: "git" | "jj" = "git", embedded = false) => (
  <WorktreeSetupCard
    snapshot={value}
    terminology={getVcsTerminology(kind)}
    embedded={embedded}
    onCancel={null}
    onWorkLocally={null}
    onOpenTerminal={null}
  />
);

it("ticks the running stage while finished stages keep their duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(card(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files7s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files12s");
});

it("stops a stage interrupted by the setup ending at the setup's end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const failed = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
  await using screen = await render(card(failed));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Check out files2s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Check out files2s");
});

describe("WorktreeSetupCard terminology", () => {
  const finished = (phase: WorktreeSetupSnapshot["phase"]) =>
    snapshot({ phase, endedAt: "2026-10-26T12:00:01.000Z", stages: [] });

  it.each([
    ["git", "Worktree"],
    ["jj", "Workspace"],
  ] as const)("uses %s labels for completed and interrupted setup", async (kind, title) => {
    for (const phase of ["done", "failed", "cancelled"] as const) {
      await using screen = await render(card(finished(phase), kind, true));
      const { container } = screen;
      expect(container.querySelector(`[aria-label="${title} setup"]`)).not.toBeNull();
      expect(container.textContent).toContain(
        phase === "done" ? `${title} ready` : `${title} setup ${phase}`,
      );
    }
  });

  it("keeps setup script failure visible in Jujutsu summaries", async () => {
    const failedSetup = finished("done");
    await using screen = await render(
      card(
        {
          ...failedSetup,
          stages: [
            {
              id: "setup-script",
              status: "failed",
              startedAt: failedSetup.startedAt,
              endedAt: failedSetup.endedAt,
              percent: null,
              detail: null,
              tail: [],
            },
          ],
        },
        "jj",
        true,
      ),
    );
    expect(screen.container.textContent).toContain("Workspace ready, setup script failed");
  });
});
