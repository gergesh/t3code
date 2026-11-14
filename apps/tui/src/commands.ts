import type { RuntimeMode } from "@t3tools/contracts";

export type SlashCommandName =
  | "new"
  | "threads"
  | "model"
  | "mode"
  | "plan"
  | "implement"
  | "queue"
  | "verbose"
  | "copy"
  | "stop"
  | "help"
  | "quit";

export interface SlashCommand {
  readonly name: SlashCommandName;
  readonly description: string;
  /** Shown beside the description; the command also has this shortcut. */
  readonly key?: string;
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "new", description: "Start a new thread in this folder", key: "ctrl+n" },
  { name: "threads", description: "Open another thread in this folder", key: "ctrl+t" },
  { name: "model", description: "Choose the model for the next message", key: "ctrl+l" },
  { name: "mode", description: "Choose the permission mode" },
  { name: "plan", description: "Turn plan mode on or off", key: "shift+tab" },
  { name: "implement", description: "Leave plan mode and implement the proposed plan" },
  { name: "queue", description: "Send a queued message now, edit it, or remove it" },
  { name: "verbose", description: "Show or hide thinking and tool output", key: "ctrl+o" },
  { name: "copy", description: "Copy the last reply" },
  { name: "stop", description: "Stop the running turn", key: "esc" },
  { name: "help", description: "Show keys and commands" },
  { name: "quit", description: "Leave the TUI", key: "ctrl+d" },
];

export const RUNTIME_MODES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Asks before commands and file changes",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Approves edits; other actions can still ask",
  },
  { mode: "auto", label: "Auto", description: "The provider's review approves routine actions" },
  { mode: "full-access", label: "Full access", description: "Never asks for approval" },
];

export function runtimeModeLabel(mode: RuntimeMode): string {
  return RUNTIME_MODES.find((entry) => entry.mode === mode)?.label ?? mode;
}

/**
 * The command a composer draft names: a slash, a known command, and nothing after it.
 * Other text, including a path like `/tmp/x`, is a message.
 */
export function parseSlashCommand(text: string): SlashCommandName | null {
  const match = /^\/([a-z]+)\s*$/.exec(text.trim());
  return SLASH_COMMANDS.find((command) => command.name === match?.[1])?.name ?? null;
}

/** Commands a draft could still become, while it is a bare `/word`. */
export function completeSlashCommand(text: string): ReadonlyArray<SlashCommand> {
  const match = /^\/([a-z]*)$/.exec(text);
  if (match === null) return [];
  const prefix = match[1] ?? "";
  // The command typed in full leads, so enter runs `/mode` rather than `/model`.
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix)).toSorted(
    (left, right) => Number(right.name === prefix) - Number(left.name === prefix),
  );
}

/** Case-insensitive match on every word of the query, in any order. */
export function matchesFilter(query: string, ...fields: ReadonlyArray<string>): boolean {
  const haystack = fields.join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .every((word) => haystack.includes(word));
}
