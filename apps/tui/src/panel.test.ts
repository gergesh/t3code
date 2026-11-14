import { describe, expect, it } from "vite-plus/test";

import { RuntimeRequestId } from "@t3tools/contracts";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";

import { completeSlashCommand, parseSlashCommand } from "./commands.ts";
import {
  startQuestionDraft,
  stepQuestion,
  type QuestionDraft,
  type QuestionStep,
} from "./panel.ts";

const option = (label: string, value?: string) => ({
  label,
  description: `${label} description`,
  ...(value === undefined ? {} : { value }),
});

const pending = (
  questions: ReadonlyArray<Partial<ThreadPendingUserInput["questions"][number]>>,
): ThreadPendingUserInput => ({
  requestId: RuntimeRequestId.make("request"),
  createdAt: "2026-11-14T00:00:00.000Z",
  responseCapability: "live",
  dismissible: true,
  questions: questions.map((question, index) => ({
    id: `q${index}`,
    header: `Header ${index}`,
    question: `Question ${index}?`,
    options: [option("Red", "red"), option("Blue", "blue")],
    multiSelect: false,
    ...question,
  })),
});

const draftOf = (step: QuestionStep): QuestionDraft => {
  if (step.type === "submit") throw new Error("expected a draft");
  return step.draft;
};

describe("stepQuestion", () => {
  it("takes the highlighted option, moves to the next question, then submits", () => {
    const input = pending([{}, {}]);
    const first = stepQuestion(input, startQuestionDraft(input), {
      type: "choose",
      option: 1,
      typed: "",
    });
    expect(draftOf(first).index).toBe(1);
    expect(stepQuestion(input, draftOf(first), { type: "choose", option: 0, typed: "" })).toEqual({
      type: "submit",
      answers: { q0: "blue", q1: "red" },
    });
  });

  it("keeps what space marked on a multi-select instead of adding the highlighted option", () => {
    const input = pending([{ multiSelect: true }]);
    const marked = draftOf(
      stepQuestion(input, startQuestionDraft(input), { type: "toggle", option: 1 }),
    );
    expect(stepQuestion(input, marked, { type: "choose", option: 0, typed: "" })).toEqual({
      type: "submit",
      answers: { q0: ["blue"] },
    });
  });

  it("prefers a typed answer unless the question refuses one", () => {
    const open = pending([{}]);
    expect(
      stepQuestion(open, startQuestionDraft(open), { type: "choose", option: 0, typed: " Green " }),
    ).toEqual({ type: "submit", answers: { q0: "Green" } });
    const closed = pending([{ allowCustomAnswer: false }]);
    expect(
      stepQuestion(closed, startQuestionDraft(closed), { type: "choose", option: 0, typed: "x" }),
    ).toEqual({ type: "submit", answers: { q0: "red" } });
  });

  it("returns to the first unanswered question when the last one is answered first", () => {
    const input = pending([{ options: [] }, {}]);
    const atLast = { ...startQuestionDraft(input), index: 1 };
    const step = stepQuestion(input, atLast, { type: "choose", option: 0, typed: "" });
    expect(step.type).toBe("incomplete");
    expect(draftOf(step).index).toBe(0);
  });
});

describe("slash commands", () => {
  it.each([
    ["/model", "model"],
    ["  /new  ", "new"],
    ["/tmp/notes.md", null],
    ["/model gpt", null],
    ["/nope", null],
  ] as const)("parses %j as %j", (text, command) => {
    expect(parseSlashCommand(text)).toBe(command);
  });

  it("completes only a bare command word", () => {
    expect(completeSlashCommand("/mo").map((command) => command.name)).toEqual(["model", "mode"]);
    expect(completeSlashCommand("/mode").map((command) => command.name)).toEqual(["mode", "model"]);
    expect(completeSlashCommand("/model ")).toEqual([]);
    expect(completeSlashCommand("hello")).toEqual([]);
  });
});
