import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { buildProjectScript, nextProjectScriptId } from "../../projectScripts";
import { importableT3FileScripts, newScriptInputFromT3File } from "../projectScriptEditor";
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
  {
    kind: "merge",
    searchId: "worktree-merge-command",
    label: msg("Worktree merge command"),
    resetLabel: msg("Reset worktree merge command to default"),
    description: msg(
      "Runs from the Merge action on worktree threads, at the project root. It must merge $T3CODE_BRANCH into the default branch and delete $T3CODE_WORKTREE_PATH.",
    ),
  },
] as const;

/**
 * Custom worktree create/remove/merge commands. A project's t3.json can suggest
 * them, but they only run once imported here, so opening a repository never
 * runs its commands on its own. Importing also brings the file's setup action,
 * which usually prepares the checkout those commands create.
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
  const scripts = settings.defaultProjectScripts;
  // Only one action runs on worktree creation, so only the file's first one is offered.
  const setupScript = importableT3FileScripts(scripts, t3File.scripts).find(
    (fileScript) => fileScript.runOnWorktreeCreate === true,
  );
  const importable =
    suggested !== undefined &&
    ((suggested.create ?? "") !== commands.create ||
      (suggested.remove ?? "") !== commands.remove ||
      (suggested.merge ?? "") !== commands.merge ||
      setupScript !== undefined);

  // One write for both keys: each override write replaces the project's whole entry.
  const importFromFile = () => {
    if (suggested === undefined) return;
    const newScript = setupScript
      ? buildProjectScript(
          nextProjectScriptId(
            setupScript.name,
            scripts.map((script) => script.id),
          ),
          newScriptInputFromT3File(setupScript),
        )
      : null;
    updateSettings({
      worktreeCommands: {
        create: suggested.create ?? "",
        remove: suggested.remove ?? "",
        merge: suggested.merge ?? "",
      },
      ...(newScript
        ? {
            defaultProjectScripts: [
              ...scripts.map((script) => ({ ...script, runOnWorktreeCreate: false })),
              newScript,
            ],
          }
        : {}),
    });
  };

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
              mixed
                ? gt("Mixed")
                : kind === "merge"
                  ? gt("None", { $context: "no merge command" })
                  : gt("Built-in", { $context: "default worktree step" })
            }
            spellCheck={false}
            aria-label={m(label)}
          />
          {kind === "create" && importable ? (
            <Button size="xs" variant="outline" className="self-end" onClick={importFromFile}>
              {gt("Use t3.json setup")}
            </Button>
          ) : null}
        </div>
      }
    />
  ));
}
