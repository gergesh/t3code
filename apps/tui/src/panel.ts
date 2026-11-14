import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";

import { completeSlashCommand, matchesFilter, type SlashCommandName } from "./commands.ts";

export interface PanelRow {
  readonly label: string;
  readonly detail?: string;
  /** A checkbox or radio mark before the label. */
  readonly mark?: string;
}

export interface Panel {
  readonly title: string;
  readonly rows: ReadonlyArray<PanelRow>;
  readonly selected: number;
  readonly hint: string;
}

export interface PickerItem<A> {
  readonly label: string;
  readonly detail?: string;
  readonly value: A;
}

export interface Picker<A> {
  readonly title: string;
  readonly items: ReadonlyArray<PickerItem<A>>;
  /** The item the picker opens on, such as the current model. */
  readonly initial?: number;
}

export function filterPicker<A>(picker: Picker<A>, query: string): ReadonlyArray<PickerItem<A>> {
  return picker.items.filter((item) => matchesFilter(query, item.label, item.detail ?? ""));
}

export function clampSelection(selected: number, count: number): number {
  return count === 0 ? 0 : Math.min(Math.max(selected, 0), count - 1);
}

export function pickerPanel<A>(picker: Picker<A>, query: string, selected: number): Panel {
  const items = filterPicker(picker, query);
  return {
    title: picker.title,
    rows: items.length > 0 ? items : [{ label: "Nothing matches" }],
    selected: clampSelection(selected, items.length),
    hint: "type to filter · ↑↓ move · enter choose · esc close",
  };
}

export function slashPanel(text: string, selected: number): Panel | null {
  const commands = completeSlashCommand(text);
  if (commands.length === 0) return null;
  return {
    title: "Commands",
    rows: commands.map((command) => ({
      label: `/${command.name}`,
      detail: command.key ? `${command.description}  (${command.key})` : command.description,
    })),
    selected: clampSelection(selected, commands.length),
    hint: "↑↓ move · tab complete · enter run",
  };
}

export function slashCommandAt(text: string, selected: number): SlashCommandName | null {
  const commands = completeSlashCommand(text);
  return commands[clampSelection(selected, commands.length)]?.name ?? null;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<Pick<ProviderApprovalOption, "decision" | "label">> =
  [
    { decision: "accept", label: "Yes" },
    { decision: "acceptForSession", label: "Yes, and don't ask again this session" },
    { decision: "decline", label: "No" },
  ];

export function approvalOptions(
  approval: ThreadPendingApproval,
): ReadonlyArray<Pick<ProviderApprovalOption, "decision" | "label" | "warning">> {
  return approval.options && approval.options.length > 0
    ? approval.options
    : DEFAULT_APPROVAL_OPTIONS;
}

export function approvalPanel(approval: ThreadPendingApproval, selected: number): Panel {
  const options = approvalOptions(approval);
  return {
    title: [
      `Approve ${approval.requestKind}${approval.appName ? ` for ${approval.appName}` : ""}?`,
      approval.detail,
      approval.reason,
    ]
      .filter(Boolean)
      .join("\n"),
    rows: options.map((option, index) => ({
      label: `${index + 1}. ${option.label}`,
      ...(option.warning ? { detail: option.warning } : {}),
    })),
    selected: clampSelection(selected, options.length),
    hint: approval.supportsFeedback
      ? "↑↓ move · enter choose · type a reason, then choose No to send it"
      : "↑↓ move · enter or 1-9 choose",
  };
}

export function approvalDecision(
  approval: ThreadPendingApproval,
  selected: number,
): ProviderApprovalDecision {
  const options = approvalOptions(approval);
  return options[clampSelection(selected, options.length)]!.decision;
}

/** Answers in progress for one pending question set. */
export interface QuestionDraft {
  readonly requestId: string;
  readonly index: number;
  readonly answers: Readonly<Record<string, PendingUserInputDraftAnswer>>;
}

export const startQuestionDraft = (input: ThreadPendingUserInput): QuestionDraft => ({
  requestId: input.requestId,
  index: 0,
  answers: {},
});

export function questionPanel(
  input: ThreadPendingUserInput,
  draft: QuestionDraft,
  selected: number,
): Panel {
  if (input.responseMode === "message") {
    return {
      title: input.questions.map((question) => question.question).join("\n"),
      rows: [],
      selected: 0,
      hint: "reply in a message",
    };
  }
  const question = input.questions[draft.index]!;
  const answer = draft.answers[question.id];
  const position =
    input.questions.length > 1 ? ` (${draft.index + 1}/${input.questions.length})` : "";
  const custom = answer?.customAnswer?.trim();
  return {
    title: `${question.header}${position}\n${question.question}`,
    rows: question.options.map((option, index) => {
      const chosen = isPendingUserInputOptionSelected(
        question,
        answer,
        option.value ?? option.label,
      );
      return {
        label: `${index + 1}. ${option.label}`,
        ...(option.description === option.label ? {} : { detail: option.description }),
        mark: question.multiSelect ? (chosen ? "[x]" : "[ ]") : chosen ? "(•)" : "( )",
      };
    }),
    selected: clampSelection(selected, question.options.length),
    hint: [
      question.multiSelect ? "space toggle · enter next" : "enter choose",
      question.allowCustomAnswer === false ? null : "or type your own answer",
      draft.index > 0 ? "← back" : null,
      input.dismissible ? "esc dismiss" : null,
      custom ? `your answer: ${custom}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export type QuestionStep =
  | { readonly type: "draft"; readonly draft: QuestionDraft }
  | {
      readonly type: "submit";
      readonly answers: Readonly<Record<string, PendingUserInputAnswer>>;
    }
  | { readonly type: "incomplete"; readonly draft: QuestionDraft };

/**
 * One keypress on the current question: `toggle` marks an option, `choose` takes
 * the typed text or the highlighted option and moves on, submitting after the last.
 */
export function stepQuestion(
  input: ThreadPendingUserInput,
  draft: QuestionDraft,
  action:
    | { readonly type: "toggle"; readonly option: number }
    | { readonly type: "choose"; readonly option: number; readonly typed: string }
    | { readonly type: "back" },
): QuestionStep {
  const question = input.questions[draft.index]!;
  if (action.type === "back") {
    return { type: "draft", draft: { ...draft, index: Math.max(0, draft.index - 1) } };
  }
  const option = question.options[action.option];
  const current = draft.answers[question.id];
  const withAnswer = (next: PendingUserInputDraftAnswer): QuestionDraft => ({
    ...draft,
    answers: { ...draft.answers, [question.id]: next },
  });
  if (action.type === "toggle") {
    return option === undefined
      ? { type: "draft", draft }
      : {
          type: "draft",
          draft: withAnswer(
            togglePendingUserInputOptionSelection(question, current, option.value ?? option.label),
          ),
        };
  }
  const typed = action.typed.trim();
  let answered = draft;
  if (typed.length > 0 && question.allowCustomAnswer !== false) {
    answered = withAnswer(setPendingUserInputCustomAnswer(question, current, typed));
  } else if (option !== undefined) {
    const chosen = isPendingUserInputOptionSelected(
      question,
      current,
      option.value ?? option.label,
    );
    const multiSelected = question.multiSelect && (current?.selectedOptionValues?.length ?? 0) > 0;
    // A multi-select keeps what space marked; a single choice takes the highlighted option.
    if (!chosen && !multiSelected) {
      answered = withAnswer(
        togglePendingUserInputOptionSelection(question, current, option.value ?? option.label),
      );
    }
  }
  if (draft.index + 1 < input.questions.length) {
    return { type: "draft", draft: { ...answered, index: draft.index + 1 } };
  }
  const answers = buildPendingUserInputAnswers(input.questions, answered.answers);
  if (answers !== null) return { type: "submit", answers };
  const unanswered = input.questions.findIndex(
    (entry) => resolvePendingUserInputAnswer(entry, answered.answers[entry.id]) === null,
  );
  return { type: "incomplete", draft: { ...answered, index: Math.max(0, unanswered) } };
}
