import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  GIT_VCS_TERMINOLOGY,
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  type VcsTerminology,
} from "@t3tools/shared/vcs";
import { sourceControlClients, type ChangeRequestTerminology } from "../sourceControlClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type GitActionSurface = "web" | "mobile";
export type GitActionIconName = "commit" | "push" | "pr";
export type GitDialogAction = "commit" | "push" | "create_pr";
export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}
export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}
export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}
export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";
export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

function changeRequestTerminologyFor(gitStatus: VcsStatusResult | null): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

/** Web spells the change request out, mobile abbreviates it; `kind` picks the translated phrase. */
function changeRequestPhrase(
  terminology: ChangeRequestTerminology,
  surface: GitActionSurface,
): {
  readonly kind: "pr" | "mr" | "pull_request" | "merge_request" | "generic" | "other";
  readonly changeRequest: string;
} {
  const changeRequest =
    surface === "web" ? `a ${terminology.singular}` : terminology.shortLabelWithArticle;
  switch (changeRequest) {
    case "a PR":
      return { kind: "pr", changeRequest };
    case "an MR":
      return { kind: "mr", changeRequest };
    case "a pull request":
      return { kind: "pull_request", changeRequest };
    case "a merge request":
      return { kind: "merge_request", changeRequest };
    case "a change request":
      return { kind: "generic", changeRequest };
    default:
      return { kind: "other", changeRequest };
  }
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
  surface: GitActionSurface = "mobile",
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const blocked = isBusy || resolveVcsUnsupportedReason(gitStatus) !== null;
  const hasBranch = gitStatus.refName !== null;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canPush =
    !blocked &&
    hasBranch &&
    (surface === "web" || !gitStatus.hasWorkingTreeChanges) &&
    gitStatus.behindCount === 0 &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !blocked &&
    hasBranch &&
    !hasOpenPr &&
    !(surface === "mobile" && gitStatus.vcs?.kind === "jj" && gitStatus.hasWorkingTreeChanges) &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    gitStatus.behindCount === 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const items: GitActionMenuItem[] = [
    {
      id: "commit",
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: blocked || !gitStatus.hasWorkingTreeChanges,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
  ];
  if (surface === "web" && !hasOriginRemote) return items;
  items.push({
    id: "push",
    label: resolve(msg("Push", { $context: "verb, git action" })),
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  });
  if (surface === "web" && hasOpenPr) return items;
  const shortLabel = changeRequestTerminologyFor(gitStatus).shortLabel;
  items.push(
    hasOpenPr
      ? {
          id: "pr",
          label: resolve(msg("View {shortLabel}", { shortLabel })),
          disabled: blocked,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: resolve(msg("Create {shortLabel}", { shortLabel })),
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  );
  return items;
}

export function hasUsableGitMenuContent(input: {
  readonly menuItems: readonly GitActionMenuItem[];
  readonly canWriteSourceControl: boolean;
  readonly canPublishRepository: boolean;
  readonly hasNotice: boolean;
}): boolean {
  return (
    input.canPublishRepository ||
    input.hasNotice ||
    (input.canWriteSourceControl && input.menuItems.some((item) => !item.disabled))
  );
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
  surface: GitActionSurface = "mobile",
): GitQuickAction {
  const vcs = resolveVcsTerminology(gitStatus);
  const commitLabel = resolve(msg("Commit", { $context: "verb, git action" }));
  const pushLabel = resolve(msg("Push", { $context: "verb, git action" }));
  if (isBusy)
    return {
      label: commitLabel,
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("{systemName} action in progress.", { systemName: vcs.systemName })),
    };
  if (!gitStatus)
    return {
      label: commitLabel,
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("{systemName} status is unavailable.", { systemName: vcs.systemName })),
    };
  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null)
    return { label: commitLabel, disabled: true, kind: "show_hint", hint: unsupportedReason };
  const terminology = changeRequestTerminologyFor(gitStatus);
  const shortLabel = terminology.shortLabel;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const resting: GitQuickAction = {
    label: commitLabel,
    disabled: true,
    kind: "show_hint",
    hint: resolve(
      msg("{refNounTitle} is up to date. No action needed.", { refNounTitle: vcs.refNounTitle }),
    ),
  };
  const viewPr: GitQuickAction = {
    label: resolve(msg("View {shortLabel}", { shortLabel })),
    disabled: false,
    kind: "open_pr",
  };
  if (gitStatus.refName === null)
    return {
      label: commitLabel,
      disabled: true,
      kind: "show_hint",
      hint: vcs.quickNoRefHint(changeRequestPhrase(terminology, surface).changeRequest, surface),
    };
  if (gitStatus.hasWorkingTreeChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasOriginRemote))
      return { label: commitLabel, disabled: false, kind: "run_action", action: "commit" };
    if (hasOpenPr || isDefaultBranch)
      return {
        label: resolve(msg("Commit & push")),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    return {
      label: resolve(msg("Commit, push & {shortLabel}", { shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }
  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (surface === "web")
        return {
          label: resolve(msg("Publish repository")),
          disabled: false,
          kind: "open_publish",
        };
      if (hasOpenPr && !isAhead) return viewPr;
      return {
        label: pushLabel,
        disabled: true,
        kind: "show_hint",
        hint: resolve(
          msg(
            '{kind, select, pr {Add an "origin" remote before pushing or creating a PR.} mr {Add an "origin" remote before pushing or creating an MR.} generic {Add an "origin" remote before pushing or creating a change request.} other {Add an "origin" remote before pushing or creating {changeRequest}.}}',
            changeRequestPhrase(terminology, "mobile"),
          ),
        ),
      };
    }
    if (!isAhead) {
      if (hasOpenPr) return surface === "web" ? resting : viewPr;
      return {
        label: pushLabel,
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg("No local {changeNoun}s to push.", { changeNoun: vcs.changeNoun })),
      };
    }
  } else {
    if (isAhead && isBehind)
      return {
        label: resolve(
          msg("Sync {refNoun}", {
            refNoun: surface === "web" ? vcs.genericRefNoun : vcs.refNoun,
          }),
        ),
        disabled: true,
        kind: "show_hint",
        hint: resolve(
          msg("{refNounTitle} has diverged from upstream. Rebase/merge first.", {
            refNounTitle: vcs.refNounTitle,
          }),
        ),
      };
    if (isBehind)
      return {
        label: resolve(msg("Pull", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_pull",
      };
  }
  if (isAhead) {
    if (hasOpenPr || isDefaultBranch)
      return {
        label: pushLabel,
        disabled: false,
        kind: "run_action",
        action: "push",
      };
    return {
      label: resolve(msg("Push & create {shortLabel}", { shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }
  if (hasOpenPr && gitStatus.hasUpstream) return surface === "web" ? resting : viewPr;
  if (hasDefaultBranchDelta && !isDefaultBranch)
    return {
      label: resolve(msg("Create {shortLabel}", { shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  return resting;
}

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasOriginRemote: boolean;
    surface?: GitActionSurface;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote, surface = "mobile" } = input;
  const vcs = resolveVcsTerminology(gitStatus);
  if (!item.disabled) return null;
  if (isBusy)
    return resolve(msg("{systemName} action in progress.", { systemName: vcs.systemName }));
  if (!gitStatus)
    return resolve(msg("{systemName} status is unavailable.", { systemName: vcs.systemName }));
  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null) return unsupportedReason;
  const terminology = changeRequestTerminologyFor(gitStatus);
  const phrase = changeRequestPhrase(terminology, surface);
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  if (item.id === "commit")
    return !hasChanges
      ? surface === "web"
        ? vcs.cleanCommitHint
        : resolve(
            msg("{workspaceNounTitle} is clean. Make changes before committing.", {
              workspaceNounTitle: vcs.workspaceNounTitle,
            }),
          )
      : resolve(msg("Commit is currently unavailable."));
  if (item.id === "push") {
    if (gitStatus.refName === null) return vcs.noRefHint("pushing", surface);
    // Web pushes committed work even with a dirty tree, so only mobile blocks on local changes.
    if (surface === "mobile" && hasChanges) return vcs.dirtyPushHint;
    if (gitStatus.behindCount > 0)
      return resolve(
        msg("{refNounTitle} is behind upstream. Pull/rebase before pushing.", {
          refNounTitle: vcs.refNounTitle,
        }),
      );
    if (!gitStatus.hasUpstream && !hasOriginRemote)
      return resolve(msg('Add an "origin" remote before pushing.'));
    if (gitStatus.aheadCount <= 0)
      return resolve(msg("No local {changeNoun}s to push.", { changeNoun: vcs.changeNoun }));
    return resolve(msg("Push is currently unavailable."));
  }
  if (surface === "mobile" && gitStatus.pr?.state === "open")
    return resolve(
      msg("View {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel }),
    );
  if (gitStatus.refName === null) return vcs.noRefHint(`creating ${phrase.changeRequest}`, surface);
  if (surface === "mobile" && gitStatus.vcs?.kind === "jj" && hasChanges) return vcs.dirtyPushHint;
  if (!gitStatus.hasUpstream && !hasOriginRemote)
    return resolve(
      msg(
        'Add an "origin" remote before creating {kind, select, pr {a PR} mr {an MR} pull_request {a pull request} merge_request {a merge request} generic {a change request} other {{changeRequest}}}.',
        phrase,
      ),
    );
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0)
    return resolve(
      msg(
        "No local {changeNoun}s to include in {kind, select, pr {a PR} mr {an MR} pull_request {a pull request} merge_request {a merge request} generic {a change request} other {{changeRequest}}}.",
        { ...phrase, changeNoun: vcs.changeNoun },
      ),
    );
  if (gitStatus.behindCount > 0)
    return resolve(
      msg(
        "{refNounTitle} is behind upstream. Pull/rebase before creating {kind, select, pr {a PR} mr {an MR} pull_request {a pull request} merge_request {a merge request} generic {a change request} other {{changeRequest}}}.",
        { ...phrase, refNounTitle: vcs.refNounTitle },
      ),
    );
  return resolve(
    msg("Create {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel }),
  );
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  return (
    isDefaultBranch &&
    (action === "push" ||
      action === "create_pr" ||
      action === "commit_push" ||
      action === "commit_push_pr")
  );
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    vcsTerminology?: VcsTerminology;
    terminology?: ChangeRequestTerminology;
    surface?: GitActionSurface;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const vcs = input.vcsTerminology ?? GIT_VCS_TERMINOLOGY;
  const surface = input.surface ?? "mobile";
  const refNoun = surface === "web" ? vcs.genericRefNoun : vcs.refNoun;
  const terminology = input.terminology ?? sourceControlClients.get(undefined).changeRequest;
  const shortLabel = terminology.shortLabel;
  const branch = input.branchName;
  const changeNoun = vcs.changeNoun;
  if (input.action === "push" || input.action === "commit_push")
    return input.includesCommit
      ? {
          title: resolve(msg("Commit & push to default {refNoun}?", { refNoun })),
          description: resolve(
            msg(
              'This action will commit and push changes on "{branch}". You can continue on this {refNoun} or create a feature {refNoun} and run the same action there.',
              { branch, refNoun },
            ),
          ),
          continueLabel: resolve(msg("Commit & push to {branch}", { branch })),
        }
      : {
          title: resolve(msg("Push to default {refNoun}?", { refNoun })),
          description: resolve(
            msg(
              'This action will push local {changeNoun}s on "{branch}". You can continue on this {refNoun} or create a feature {refNoun} and run the same action there.',
              { branch, refNoun, changeNoun },
            ),
          ),
          continueLabel: resolve(msg("Push to {branch}", { branch })),
        };
  const phrase = changeRequestPhrase(terminology, surface);
  return input.includesCommit
    ? {
        title: resolve(
          msg("Commit, push & create {shortLabel} from default {refNoun}?", {
            shortLabel,
            refNoun,
          }),
        ),
        description: resolve(
          msg(
            'This action will commit, push, and create {kind, select, pr {a PR} mr {an MR} pull_request {a pull request} merge_request {a merge request} generic {a change request} other {{changeRequest}}} on "{branch}". You can continue on this {refNoun} or create a feature {refNoun} and run the same action there.',
            { ...phrase, branch, refNoun },
          ),
        ),
        continueLabel: resolve(msg("Commit, push & create {shortLabel}", { shortLabel })),
      }
    : {
        title: resolve(
          msg("Push & create {shortLabel} from default {refNoun}?", { shortLabel, refNoun }),
        ),
        description: resolve(
          msg(
            'This action will push local {changeNoun}s and create {kind, select, pr {a PR} mr {an MR} pull_request {a pull request} merge_request {a merge request} generic {a change request} other {{changeRequest}}} on "{branch}". You can continue on this {refNoun} or create a feature {refNoun} and run the same action there.',
            { ...phrase, branch, refNoun, changeNoun },
          ),
        ),
        continueLabel: resolve(msg("Push & create {shortLabel}", { shortLabel })),
      };
}

/** The server names a feature branch from the commit it makes, so the action must commit changes. */
export function resolveFeatureBranchUnavailableReason(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    hasWorkingTreeChanges: boolean;
    vcsTerminology?: VcsTerminology;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const refNoun = (input.vcsTerminology ?? GIT_VCS_TERMINOLOGY).refNoun;
  const branch = input.branchName;
  if (!input.hasWorkingTreeChanges)
    return resolve(
      msg(
        "There are no changes to commit, so a feature {refNoun} can't be named. Create a {refNoun} yourself or continue on {branch}.",
        { refNoun, branch },
      ),
    );
  if (input.action === "push" || input.action === "create_pr")
    return resolve(
      msg(
        "This action doesn't commit your changes, so a feature {refNoun} can't be named. Create a {refNoun} yourself or continue on {branch}.",
        { refNoun, branch },
      ),
    );
  return null;
}
