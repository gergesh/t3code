import { sanitizeFeatureBranchName, sanitizeNewRefName } from "@t3tools/shared/git";
import {
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  supportsVcsActions,
} from "@t3tools/shared/vcs";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { AppText as Text } from "../../../components/ui/AppText";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { FormField, FormSection } from "../../../components/ui/FormSection";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { useEnvironmentQuery } from "../../../state/query";
import { useDebouncedValue, usePaginatedBranches } from "../../../state/queries";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { useRefreshBranchesOnFocus } from "../use-refresh-branches-on-focus";
import { filterNewTaskBranches } from "../new-task-context-presentation";
import { SheetActionButton } from "./gitSheetComponents";

const BRANCH_SEARCH_DEBOUNCE_MS = 150;

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitBranchesSheet(_props: GitBranchesSheetProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  useRefreshBranchesOnFocus(selectedThread?.environmentId, selectedThreadCwd);
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const canChangeThreadBranch = gitActions.canChangeThreadBranch;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd, includeRemote: false },
        })
      : null,
  );

  const vcsTerminology = resolveVcsTerminology(gitStatus.data);
  const vcsUnsupportedReason = resolveVcsUnsupportedReason(gitStatus.data);
  const vcsActionsSupported = supportsVcsActions(gitStatus.data);
  const currentBranch = gitStatus.data?.refName ?? selectedThread?.branch ?? null;
  const currentWorktreePath = selectedThreadCwd;
  const [branchQuery, setBranchQuery] = useState("");
  const branchSearchQuery = sanitizeNewRefName(branchQuery);
  const debouncedBranchQuery = useDebouncedValue(branchSearchQuery, BRANCH_SEARCH_DEBOUNCE_MS);
  // Server order: current, default, local by recency, then remote-only refs. The query runs on the
  // server so it reaches refs past the first page; the local filter keeps typing instant.
  const branchState = usePaginatedBranches({
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
    query: debouncedBranchQuery,
  });
  const availableBranches = filterNewTaskBranches(branchState.refs, branchQuery);
  const branchesLoading =
    branchSearchQuery !== debouncedBranchQuery ||
    (branchState.isPending && branchState.data === null);
  const hasMoreBranches =
    branchState.data?.nextCursor !== null && branchState.data?.nextCursor !== undefined;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranchOverride, setWorktreeBaseBranchOverride] = useState<string | null>(null);
  const worktreeBaseBranch =
    worktreeBaseBranchOverride ?? (currentBranch === null ? "main" : currentBranch);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranchNames: Array<string> = [];
  for (const branch of availableBranches) {
    if (branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath) {
      disabledExistingBranchNames.push(branch.name);
    }
  }
  const disabledExistingBranches = new Set(disabledExistingBranchNames);

  return (
    <FitSheet
      header={
        <SheetHeader
          title={gt("{refNounPluralTitle} & {workspaceNounPlural}", {
            refNounPluralTitle: vcsTerminology.refNounPluralTitle,
            workspaceNounPlural: vcsTerminology.workspaceNounPlural,
          })}
          onClose={() => navigation.goBack()}
        />
      }
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {vcsUnsupportedReason ? (
        <Text accessibilityRole="alert" className="text-warning-foreground">
          {vcsUnsupportedReason}
        </Text>
      ) : null}
      <FormSection title={gt("New {refNoun}", { refNoun: vcsTerminology.refNoun })}>
        <FormField
          value={newBranchName}
          onChangeText={setNewBranchName}
          placeholder="feature/mobile-polish"
          accessibilityLabel={gt("New {refNoun} name", { refNoun: vcsTerminology.refNoun })}
        />
        <SheetActionButton
          icon="plus"
          label={vcsTerminology.createAndSwitchLabel}
          tone="primary"
          disabled={
            !vcsActionsSupported ||
            !canChangeThreadBranch ||
            busy ||
            newBranchName.trim().length === 0
          }
          onPress={() => {
            if (!vcsActionsSupported) return;
            const branch = sanitizeFeatureBranchName(newBranchName.trim());
            if (branch.length === 0) return;
            void gitActions.onCreateSelectedThreadBranch(branch).then((result) => {
              if (result === null || !navigation.isFocused()) return;
              setNewBranchName("");
              navigation.goBack();
            });
          }}
        />
      </FormSection>

      <FormSection
        title={gt("New {workspaceNoun}", { workspaceNoun: vcsTerminology.workspaceNoun })}
      >
        <FormField
          label={gt("Base {refNoun}", { refNoun: vcsTerminology.refNoun })}
          value={worktreeBaseBranch}
          onChangeText={setWorktreeBaseBranchOverride}
          placeholder="main"
          accessibilityLabel={gt("{workspaceNounTitle} base {refNoun}", {
            workspaceNounTitle: vcsTerminology.workspaceNounTitle,
            refNoun: vcsTerminology.refNoun,
          })}
        />
        <FormField
          label={gt("New {refNoun}", { refNoun: vcsTerminology.refNoun })}
          value={worktreeBranchName}
          onChangeText={setWorktreeBranchName}
          placeholder="feature/mobile-thread"
          accessibilityLabel={gt("{workspaceNounTitle} {refNoun} name", {
            workspaceNounTitle: vcsTerminology.workspaceNounTitle,
            refNoun: vcsTerminology.refNoun,
          })}
        />
        <SheetActionButton
          icon="square.split.2x1"
          label={gt("Create {workspaceNoun}", { workspaceNoun: vcsTerminology.workspaceNoun })}
          tone="primary"
          disabled={
            !vcsActionsSupported ||
            !canChangeThreadBranch ||
            busy ||
            worktreeBaseBranch.trim().length === 0 ||
            worktreeBranchName.trim().length === 0
          }
          onPress={() => {
            if (!vcsActionsSupported) return;
            const baseBranch = worktreeBaseBranch.trim();
            const newBranch = worktreeBranchName.trim();
            if (baseBranch.length === 0 || newBranch.length === 0) return;
            void gitActions
              .onCreateSelectedThreadWorktree({ baseBranch, newBranch })
              .then((result) => {
                if (result === null || !navigation.isFocused()) return;
                setWorktreeBranchName("");
                navigation.goBack();
              });
          }}
        />
      </FormSection>

      <FormSection
        title={gt("Existing {refNounPlural}", { refNounPlural: vcsTerminology.refNounPlural })}
      >
        <FormField
          value={branchQuery}
          onChangeText={setBranchQuery}
          placeholder={gt("Search {refNounPlural}", {
            refNounPlural: vcsTerminology.refNounPlural,
          })}
          accessibilityLabel={gt("Search {refNounPlural}", {
            refNounPlural: vcsTerminology.refNounPlural,
          })}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </FormSection>
      <ListSection
        footer={
          branchesLoading
            ? gt("Loading {refNounPlural}...", { refNounPlural: vcsTerminology.refNounPlural })
            : (branchState.error ??
              (availableBranches.length === 0
                ? gt("No {refNounPlural} found.", { refNounPlural: vcsTerminology.refNounPlural })
                : undefined))
        }
      >
        {availableBranches.map((branch, index) => {
          const disabled = disabledExistingBranches.has(branch.name);
          const subtitle = branch.worktreePath
            ? branch.worktreePath === currentWorktreePath
              ? gt("Checked out in this thread")
              : gt("Checked out in another {workspaceNoun}", {
                  workspaceNoun: vcsTerminology.workspaceNoun,
                })
            : branch.isDefault
              ? vcsTerminology.defaultRefLabel
              : branch.isRemote
                ? gt("Remote {refNoun}", { refNoun: vcsTerminology.refNoun })
                : gt("Local {refNoun}", { refNoun: vcsTerminology.refNoun });

          return (
            <ListChoiceRow
              key={branch.name}
              label={branch.name}
              description={subtitle}
              selected={branch.current}
              separated={index > 0}
              disabled={!vcsActionsSupported || !canChangeThreadBranch || busy || disabled}
              onPress={() => {
                if (!vcsActionsSupported) return;
                void gitActions.onCheckoutSelectedThreadBranch(branch.name).then((result) => {
                  if (result === null || !navigation.isFocused()) return;
                  navigation.goBack();
                });
              }}
            />
          );
        })}
      </ListSection>
      {hasMoreBranches ? (
        <SheetActionButton
          icon="chevron.down"
          label={gt("Show more {refNounPlural}", { refNounPlural: vcsTerminology.refNounPlural })}
          disabled={branchState.isFetchingNextPage}
          onPress={branchState.loadNext}
        />
      ) : null}
    </FitSheet>
  );
}
