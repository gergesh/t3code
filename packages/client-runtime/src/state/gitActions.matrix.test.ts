import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildMenuItems, getGitActionDisabledReason, resolveQuickAction } from "./gitActions.ts";

const clean: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/test",
  hasWorkingTreeChanges: false,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  aheadOfDefaultCount: 1,
  pr: null,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};
const openPr = {
  number: 1,
  title: "Example",
  url: "https://github.com/a/b/pull/1",
  state: "open" as const,
  baseRef: "main",
  headRef: "feature/test",
};

type Case = {
  name: string;
  status: VcsStatusResult;
  remote?: boolean;
  busy?: boolean;
  web: readonly [readonly string[], string];
  mobile: readonly [readonly string[], string];
};
const cases: Case[] = [
  {
    name: "clean Git ahead",
    status: clean,
    web: [["push", "pr"], "create_pr"],
    mobile: [["push", "pr"], "create_pr"],
  },
  {
    name: "fallback detached Git HEAD",
    status: {
      ...clean,
      refName: null,
      vcs: {
        kind: "git",
        notice:
          "Jujutsu was not found on the server’s PATH. Using Git for this colocated repository. Git HEAD may be detached: commits won't be on a branch; push needs a branch.",
      },
    },
    web: [[], "show_hint"],
    mobile: [[], "show_hint"],
  },
  {
    name: "dirty Git ahead",
    status: { ...clean, hasWorkingTreeChanges: true },
    web: [["commit", "push", "pr"], "commit_push_pr"],
    mobile: [["commit", "pr"], "commit_push_pr"],
  },
  {
    name: "dirty jj ahead",
    status: { ...clean, vcs: { kind: "jj" }, hasWorkingTreeChanges: true },
    web: [["commit", "push", "pr"], "commit_push_pr"],
    mobile: [["commit"], "commit_push_pr"],
  },
  {
    name: "clean jj ahead",
    status: { ...clean, vcs: { kind: "jj" } },
    web: [["push", "pr"], "create_pr"],
    mobile: [["push", "pr"], "create_pr"],
  },
  {
    name: "jj no bookmark",
    status: { ...clean, vcs: { kind: "jj" }, refName: null },
    web: [[], "show_hint"],
    mobile: [[], "show_hint"],
  },
  {
    name: "unsupported jj",
    status: { ...clean, vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" } },
    web: [[], "show_hint"],
    mobile: [[], "show_hint"],
  },
  {
    name: "busy",
    status: clean,
    busy: true,
    web: [[], "show_hint"],
    mobile: [[], "show_hint"],
  },
  {
    name: "behind",
    status: { ...clean, aheadCount: 0, behindCount: 1 },
    web: [[], "run_pull"],
    mobile: [[], "run_pull"],
  },
  {
    name: "diverged jj",
    status: { ...clean, vcs: { kind: "jj" }, behindCount: 1 },
    web: [[], "show_hint"],
    mobile: [[], "show_hint"],
  },
  {
    name: "no remote",
    status: { ...clean, hasUpstream: false },
    remote: false,
    web: [[], "open_publish"],
    mobile: [[], "show_hint"],
  },
  {
    name: "open PR up to date",
    status: { ...clean, aheadCount: 0, pr: openPr },
    web: [[], "show_hint"],
    mobile: [["pr"], "open_pr"],
  },
  {
    name: "pushed feature",
    status: { ...clean, aheadCount: 0 },
    web: [["pr"], "create_pr"],
    mobile: [["pr"], "show_hint"],
  },
];

describe("named web/mobile action policies", () => {
  it.each(cases)("$name", ({ status, remote = true, busy = false, ...row }) => {
    for (const surface of ["web", "mobile"] as const) {
      const menu = buildMenuItems(status, busy, remote, surface);
      expect(menu.filter((item) => !item.disabled).map((item) => item.id)).toEqual(row[surface][0]);
      const quick = resolveQuickAction(status, busy, false, remote, surface);
      expect(quick.action ?? quick.kind).toBe(row[surface][1]);
      if (status.refName === null && status.vcs?.kind === "git") {
        expect(quick).toMatchObject({
          disabled: true,
          hint:
            surface === "web"
              ? "Create and checkout a ref before pushing or opening a pull request."
              : "Create and checkout a branch before pushing or opening a PR.",
        });
        for (const id of ["push", "pr"] as const) {
          const item = menu.find((item) => item.id === id)!;
          expect(
            getGitActionDisabledReason({
              item,
              gitStatus: status,
              isBusy: busy,
              hasOriginRemote: remote,
              surface,
            }),
          ).toBe(
            `Detached HEAD: ${surface === "web" ? "check out" : "checkout"} a branch before ${id === "push" ? "pushing" : surface === "web" ? "creating a pull request" : "creating a PR"}.`,
          );
        }
      }
      if (status.vcs?.kind === "jj" && status.hasWorkingTreeChanges && surface === "mobile") {
        for (const id of ["push", "pr"] as const) {
          const item = menu.find((item) => item.id === id)!;
          expect(
            getGitActionDisabledReason({
              item,
              gitStatus: status,
              isBusy: busy,
              hasOriginRemote: remote,
              surface,
            }),
          ).toBe("Commit local changes before pushing.");
        }
      }
    }
  });

  it.each(["jj git colocation enable", "Could not read the Jujutsu workspace repository pointer."])(
    "disables unsupported jj actions with the server reason: %s",
    (reason) => {
      const status: VcsStatusResult = {
        ...clean,
        vcs: { kind: "jj", unsupportedReason: reason },
      };
      for (const surface of ["web", "mobile"] as const) {
        const items = buildMenuItems(status, false, true, surface);
        expect(items.map((item) => item.id)).toEqual(["commit", "push", "pr"]);
        for (const item of items) {
          expect(item.disabled).toBe(true);
          expect(
            getGitActionDisabledReason({
              item,
              gitStatus: status,
              isBusy: false,
              hasOriginRemote: true,
              surface,
            }),
          ).toBe(reason);
        }
        for (const hasOriginRemote of [false, true]) {
          const quickAction = resolveQuickAction(status, false, false, hasOriginRemote, surface);
          expect(quickAction.disabled).toBe(true);
          expect(quickAction.kind).toBe("show_hint");
          expect(quickAction.hint).toBe(reason);
        }
      }
    },
  );
});
