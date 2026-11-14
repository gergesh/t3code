import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";
import { contextCompactionLabel } from "@t3tools/client-runtime/work-log/presentation";
import { getQuestionAnswerPreview } from "@t3tools/client-runtime/work-log/user-input";

export type RowTone = "user" | "assistant" | "thinking" | "tool" | "todo" | "info" | "error";

/** A tool call split for display: what it did, to what, and how it went. */
export interface ToolLabel {
  readonly verb: string;
  readonly target: string;
  readonly added?: number;
  readonly removed?: number;
  /** A short outcome, such as a failing exit code or a result count. */
  readonly note?: string;
}

export interface TodoStep {
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
}

export interface TimelineRow {
  readonly id: string;
  readonly tone: RowTone;
  /** Markdown for assistant rows, plain text for the rest. */
  readonly text: string;
  readonly active: boolean;
  readonly failed: boolean;
  /** What verbose mode adds under the row: tool output, a diff, or a question's answer. */
  readonly detail: string | null;
  readonly tool?: ToolLabel;
  readonly todos?: ReadonlyArray<TodoStep>;
}

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2RunStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What a tool call did, or null for items the TUI leaves out. */
function toolLabel(item: OrchestrationV2TurnItem): ToolLabel | null {
  switch (item.type) {
    case "command_execution":
      return {
        verb: "Run",
        target: firstLine(commandDisplayText(item.input)),
        ...(item.exitCode !== undefined && item.exitCode !== 0
          ? { note: `exit ${item.exitCode}` }
          : {}),
      };
    case "file_change":
      return {
        verb: "Edit",
        target: item.fileName,
        ...(item.additions === undefined ? {} : { added: item.additions }),
        ...(item.deletions === undefined ? {} : { removed: item.deletions }),
      };
    case "file_search":
      return {
        verb: "Search",
        target: item.pattern ?? "files",
        ...(item.results ? { note: plural(item.results.length, "result") } : {}),
      };
    case "web_search":
      return { verb: "Web search", target: item.patterns?.join(", ") ?? "" };
    case "dynamic_tool": {
      // Providers title a call as "Read /path"; its first word reads as the verb.
      const title = item.title ?? item.toolName ?? "Tool";
      const space = title.indexOf(" ");
      return space === -1
        ? { verb: title, target: "" }
        : { verb: title.slice(0, space), target: title.slice(space + 1) };
    }
    case "subagent":
      return { verb: "Agent", target: item.title ?? firstLine(item.prompt) };
    default:
      return null;
  }
}

export function toolText(label: ToolLabel): string {
  const counts =
    label.added === undefined && label.removed === undefined
      ? ""
      : `  +${label.added ?? 0} -${label.removed ?? 0}`;
  return `${label.verb} ${label.target}`.trim() + counts + (label.note ? `  ${label.note}` : "");
}

function rowFor(item: OrchestrationV2TurnItem, full: OrchestrationV2TurnItem): TimelineRow | null {
  if (turnItemIsWorkspacePreparation(item)) return null;
  const active = isOrchestrationV2WorkActive(item.status);
  const failed = item.status === "failed";
  const row = (tone: RowTone, text: string, detail: string | null = null): TimelineRow => ({
    id: item.id,
    tone,
    text,
    active,
    failed,
    detail,
  });
  switch (item.type) {
    case "user_message": {
      const images = item.attachments.map(
        (attachment) => `[${attachment.type}: ${attachment.name}]`,
      );
      return row("user", [item.text, ...images].filter((part) => part.length > 0).join("  "));
    }
    case "assistant_message":
      return row("assistant", item.text);
    case "reasoning":
      return item.text.trim() ? row("thinking", item.text.trim()) : null;
    case "proposed_plan":
      return row("assistant", item.markdown);
    case "todo_list":
      return {
        ...row("todo", item.steps.map((step) => step.text).join("\n")),
        todos: item.steps.map((step) => ({ text: step.text, status: step.status })),
      };
    case "approval_request":
      // A pending approval shows in the panel above the composer instead.
      return active ? null : row("info", `Asked to approve ${item.prompt ?? item.requestKind}`);
    case "user_input_request": {
      const questions = item.questions.map((question) => question.question).join("\n");
      const answer = item.questionAnswer && getQuestionAnswerPreview(item.questionAnswer);
      return row("info", answer ? `${questions}\n→ ${answer}` : questions);
    }
    case "error":
      return { ...row("error", item.failure.message), failed: true };
    case "system_notice":
      return row(item.level === "error" ? "error" : "info", item.message);
    case "notification":
      return row("info", item.summary);
    case "run_interrupt_request":
      // The result row carries the same message once the run stops.
      return active ? row("info", item.message) : null;
    case "run_interrupt_result":
      return row("info", item.message);
    case "compaction":
      return row("info", contextCompactionLabel(item));
    default: {
      const label = toolLabel(item);
      if (label === null) return null;
      const detail =
        full.type === "file_change" ? full.diffStr?.trim() || null : turnItemOutputText(full);
      return { ...row("tool", toolText(label), detail), tool: label };
    }
  }
}

/** `fullItems` holds items fetched whole, whose output the thread stream left out. */
export function timelineRows(
  projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems">,
  fullItems: ReadonlyMap<string, OrchestrationV2TurnItem> = new Map(),
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const projected of projection.visibleTurnItems) {
    const row = rowFor(projected.item, fullItems.get(projected.item.id) ?? projected.item);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** The run the composer would interrupt, if any. */
export function activeRun(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}
