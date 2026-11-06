import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { assert, describe, it } from "vite-plus/test";
import { resolveChangesTotals, resolveLiveThreadBranchUpdate } from "./GitActionsControl.logic";
import {
  buildMenuItems as buildSharedMenuItems,
  resolveQuickAction as resolveSharedQuickAction,
  getGitActionDisabledReason as getSharedDisabledReason,
  resolveDefaultBranchActionDialogCopy as resolveSharedDialogCopy,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";

const buildMenuItems = (status: VcsStatusResult | null, busy: boolean, remote = true) =>
  buildSharedMenuItems(status, busy, remote, "web");
const resolveQuickAction = (
  status: VcsStatusResult | null,
  busy: boolean,
  defaultRef = false,
  remote = true,
) => resolveSharedQuickAction(status, busy, defaultRef, remote, "web");
const getGitActionDisabledReason = (
  input: Omit<Parameters<typeof getSharedDisabledReason>[0], "hasOriginRemote"> & {
    hasPrimaryRemote: boolean;
  },
) => getSharedDisabledReason({ ...input, hasOriginRemote: input.hasPrimaryRemote, surface: "web" });
const resolveDefaultBranchActionDialogCopy = (
  input: Parameters<typeof resolveSharedDialogCopy>[0],
) => resolveSharedDialogCopy({ ...input, surface: "web" });

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("upstream Git copy and jj action guards", () => {
  it("keeps the exact upstream detached-ref hint", () => {
    assert.deepEqual(resolveQuickAction(status({ refName: null }), false), {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Create and checkout a ref before pushing or opening a pull request.",
    });
  });

  it("keeps upstream disabled-action reasons and their priority", () => {
    const dirty = status({ hasWorkingTreeChanges: true, behindCount: 1 });
    const push = buildMenuItems(dirty, false).find((item) => item.id === "push")!;
    assert.equal(
      getGitActionDisabledReason({
        item: push,
        gitStatus: dirty,
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "Commit or stash local changes before pushing.",
    );
    const clean = status();
    const commit = buildMenuItems(clean, false)[0]!;
    assert.equal(
      getGitActionDisabledReason({
        item: commit,
        gitStatus: clean,
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "Worktree is clean. Make changes before committing.",
    );
  });

  it("does not suggest stashing jj working-copy changes before pushing", () => {
    const dirty = status({
      hasWorkingTreeChanges: true,
      aheadCount: 0,
      vcs: { kind: "jj" },
    });
    const push = buildMenuItems(dirty, false).find((item) => item.id === "push")!;
    assert.equal(
      getGitActionDisabledReason({
        item: push,
        gitStatus: dirty,
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "Commit local changes before pushing.",
    );
  });

  it("blocks every action when jj is unsupported", () => {
    const unsupported = status({
      hasWorkingTreeChanges: true,
      aheadCount: 1,
      vcs: { kind: "jj", unsupportedReason: "Jujutsu is unavailable." },
    });
    assert.isTrue(buildMenuItems(unsupported, false).every((item) => item.disabled));
    assert.deepInclude(resolveQuickAction(unsupported, false), {
      disabled: true,
      kind: "show_hint",
      hint: "Jujutsu is unavailable.",
    });
  });

  it("retains jj bookmark wording in default-ref confirmation", () => {
    assert.equal(
      resolveDefaultBranchActionDialogCopy({
        action: "push",
        branchName: "main",
        includesCommit: false,
        vcsTerminology: JJ_VCS_TERMINOLOGY,
      }).title,
      "Push to default bookmark?",
    );
  });
});

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default, even with local changes", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);

    const dirtyFeature = { ...syncedFeature, hasWorkingTreeChanges: true };
    assert.equal(
      buildMenuItems(dirtyFeature, false).find((item) => item.id === "pr")?.disabled,
      false,
    );
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });
});

describe("when: local changes are behind upstream", () => {
  it("keeps the commit action available without pushing, with or without an open PR", () => {
    const behind = status({ hasWorkingTreeChanges: true, behindCount: 2 });
    const commit = {
      label: "Commit",
      disabled: false,
      kind: "run_action",
      action: "commit",
    } as const;
    assert.deepEqual(resolveQuickAction(behind, false), commit);
    assert.deepEqual(
      resolveQuickAction(
        {
          ...behind,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        },
        false,
      ),
      commit,
    );
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });
});

describe("when: the ref is on GitLab", () => {
  const gitLab = {
    sourceControlProvider: {
      kind: SourceControlProviderKind.make("gitlab"),
      name: "GitLab",
      baseUrl: "https://gitlab.com",
    },
  };

  it("names merge requests in actions and the default-ref dialog", () => {
    const ahead = status({ ...gitLab, hasUpstream: false, aheadCount: 2 });
    assert.equal(resolveQuickAction(ahead, false).label, "Push & create MR");
    assert.equal(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
      "Commit, push & MR",
    );
    assert.equal(buildMenuItems(ahead, false).find((item) => item.id === "pr")?.label, "Create MR");

    const copy = resolveDefaultBranchActionDialogCopy({
      action: "create_pr",
      branchName: "main",
      includesCommit: false,
      terminology: sourceControlClients.get("gitlab").changeRequest,
    });
    assert.equal(copy.title, "Push & create MR from default ref?");
    assert.include(copy.description, "create a merge request on");
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });
});

describe("resolveChangesTotals", () => {
  it("does not let an empty branchChanges hide a dirty working tree", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          hasWorkingTreeChanges: true,
          branchChanges: { baseRef: "main", insertions: 0, deletions: 0 },
          workingTree: {
            files: [{ path: "a.ts", insertions: 5, deletions: 1 }],
            insertions: 5,
            deletions: 1,
          },
        }),
      ),
      { insertions: 5, deletions: 1 },
    );
  });

  it("keeps non-zero branchChanges over the working tree", () => {
    assert.deepEqual(
      resolveChangesTotals(
        status({
          branchChanges: { baseRef: "origin/master", insertions: 20, deletions: 3 },
          workingTree: {
            files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          },
        }),
      ),
      { insertions: 20, deletions: 3, baseRef: "origin/master" },
    );
  });

  it("falls back to the working tree when branchChanges is omitted", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          workingTree: {
            files: [{ path: "a.ts", insertions: 2, deletions: 0 }],
            insertions: 2,
            deletions: 0,
          },
        }),
      ),
      { insertions: 2, deletions: 0 },
    );
  });
});
