import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const COMMAND_KINDS = [
  {
    kind: "create",
    searchId: "worktree-create-command",
    label: msg("Worktree create command"),
    resetLabel: msg("Reset worktree create command to default"),
    description: msg(
      "Runs instead of the built-in worktree creation, at the project root. It must check out $T3CODE_BRANCH at $T3CODE_WORKTREE_PATH, or print the path it used as its last line.",
    ),
  },
  {
    kind: "remove",
    searchId: "worktree-remove-command",
    label: msg("Worktree remove command"),
    resetLabel: msg("Reset worktree remove command to default"),
    description: msg(
      "Runs instead of the built-in worktree removal, at the project root. It must delete $T3CODE_WORKTREE_PATH.",
    ),
  },
] as const;

/**
 * Custom worktree create/remove commands. A project's t3.json can suggest
 * them, but they only run once imported here, so opening a repository never
 * runs its commands on its own.
 */
export function WorktreeCommandsSettings() {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreeCommands"]);
  const { scope, target } = useSettingsScope();

  const member =
    (scope.kind === "project" || scope.kind === "checkout") && target?.projectId
      ? scope.members.find((candidate) => candidate.id === target.projectId)
      : undefined;
  // The query is disabled without a checkout, so any id satisfies the hook.
  const t3File = useT3ProjectFileState(
    member?.environmentId ?? EnvironmentId.make("none"),
    member?.workspaceRoot ?? null,
  );
  const suggested = t3File.file?.worktreeCommands;
  const commands = settings.worktreeCommands;
  const importable =
    suggested !== undefined &&
    ((suggested.create ?? "") !== commands.create || (suggested.remove ?? "") !== commands.remove);

  return COMMAND_KINDS.map(({ kind, searchId, label, resetLabel, description }) => (
    <SettingsRow
      key={kind}
      serverScoped
      settingKeys={["worktreeCommands"]}
      {...setting(searchId)}
      description={m(description)}
      resetAction={
        commands[kind] !== DEFAULT_UNIFIED_SETTINGS.worktreeCommands[kind] ? (
          <SettingResetButton
            ariaLabel={m(resetLabel)}
            onClick={() =>
              updateSettings({
                worktreeCommands: { [kind]: DEFAULT_UNIFIED_SETTINGS.worktreeCommands[kind] },
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-72">
          <DraftInput
            size="sm"
            className="w-full"
            value={mixed ? "" : commands[kind]}
            onCommit={(next) => updateSettings({ worktreeCommands: { [kind]: next } })}
            placeholder={
              mixed ? gt("Mixed") : gt("Built-in", { $context: "default worktree step" })
            }
            spellCheck={false}
            aria-label={m(label)}
          />
          {kind === "create" && importable ? (
            <Button
              size="xs"
              variant="outline"
              className="self-end"
              onClick={() =>
                updateSettings({
                  worktreeCommands: {
                    create: suggested.create ?? "",
                    remove: suggested.remove ?? "",
                  },
                })
              }
            >
              {gt("Use t3.json commands")}
            </Button>
          ) : null}
        </div>
      }
    />
  ));
}
