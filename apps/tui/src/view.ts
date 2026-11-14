import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type {
  ModelSelection,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";

import {
  RUNTIME_MODES,
  SLASH_COMMANDS,
  parseSlashCommand,
  runtimeModeLabel,
  type SlashCommandName,
} from "./commands.ts";
import {
  approvalDecision,
  approvalPanel,
  clampSelection,
  filterPicker,
  pickerPanel,
  questionPanel,
  slashCommandAt,
  slashPanel,
  startQuestionDraft,
  stepQuestion,
  type Panel,
  type Picker,
  type QuestionDraft,
} from "./panel.ts";
import type {
  ModelChoice,
  QueueAction,
  QueuedMessage,
  SessionView,
  ThreadChoice,
} from "./session.ts";
import { pastedImagePaths } from "./attachments.ts";
import { color, makeTimeline, styled, type Segment } from "./timelineView.ts";

export interface ViewActions {
  readonly send: (
    text: string,
    attachments: ReadonlyArray<UploadChatImageAttachment>,
    queue: boolean,
  ) => void;
  /** Reads the image files; the answer arrives through `addAttachments` or `notify`. */
  readonly attachImages: (paths: ReadonlyArray<string>) => void;
  readonly pasteImage: () => void;
  readonly interrupt: () => void;
  readonly answerApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    feedback: string | null,
  ) => void;
  readonly answerQuestion: (
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers | null,
  ) => void;
  readonly setModel: (selection: ModelSelection) => void;
  readonly setRuntimeMode: (mode: RuntimeMode) => void;
  readonly togglePlanMode: () => void;
  readonly implementPlan: () => void;
  readonly newThread: () => void;
  readonly openThread: (id: ThreadId) => void;
  /** Asks for the folder's threads; the answer arrives through `showThreads`. */
  readonly listThreads: () => void;
  readonly loadEarlier: () => void;
  readonly manageQueued: (action: QueueAction) => void;
  /** Verbose rows need output the thread stream leaves out, which the session fetches. */
  readonly setVerbose: (verbose: boolean) => void;
  readonly models: () => ReadonlyArray<ModelChoice>;
  readonly exit: () => void;
}

type PickerValue =
  | { readonly type: "model"; readonly selection: ModelSelection }
  | { readonly type: "mode"; readonly mode: RuntimeMode }
  | { readonly type: "thread"; readonly id: ThreadId }
  | { readonly type: "command"; readonly name: SlashCommandName }
  | { readonly type: "queued"; readonly message: QueuedMessage }
  | {
      readonly type: "queue";
      readonly action:
        | QueueAction
        | { readonly type: "edit-draft"; readonly message: QueuedMessage };
    };

const PANEL_VISIBLE_ROWS = 8;
const HELP_KEYS = [
  "enter send (steers a running turn) · tab queue behind it · shift+enter newline",
  "↑↓ earlier messages · pageup/pagedown scroll · esc stop · ctrl+c clear/stop · ctrl+d quit",
  "ctrl+v paste an image · drop an image file to attach it",
].join("\n");

const ONE_LINE_LIMIT = 100;
const oneLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > ONE_LINE_LIMIT ? `${line.slice(0, ONE_LINE_LIMIT - 1)}…` : line;
};

/** Context use as a short bar that turns warm as the window fills. */
const contextMeter = (percent: number): Segment => {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 20);
  return {
    text: `ctx ${"▰".repeat(filled)}${"▱".repeat(5 - filled)} ${Math.round(percent)}%`,
    fg: percent >= 85 ? color.error : percent >= 60 ? color.warning : color.muted,
  };
};

const formatAge = (epochMillis: number, now: number) => {
  const minutes = Math.round((now - epochMillis) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
};

export function mountView(renderer: CliRenderer, actions: ViewActions) {
  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingRight: 1,
  });
  // Only the conversation shrinks; the chrome around it keeps its height.
  const header = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: color.surface,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  // One line that truncates as the terminal narrows; the path gives way first, then the project.
  const headerText = { wrapMode: "none", truncate: true } as const;
  const headerTitle = new TextRenderable(renderer, {
    ...headerText,
    content: "",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 8,
  });
  const headerProject = new TextRenderable(renderer, {
    ...headerText,
    content: "",
    fg: color.accent,
    flexShrink: 1,
    marginLeft: 2,
  });
  const headerLocation = new TextRenderable(renderer, {
    ...headerText,
    content: "",
    fg: color.subtle,
    flexShrink: 1000,
    marginLeft: 2,
  });
  header.add(headerTitle);
  header.add(headerProject);
  header.add(headerLocation);
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column", paddingBottom: 1 },
  });
  const panelBox = new BoxRenderable(renderer, {
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: color.accent,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
    visible: false,
  });
  const panelTitle = new TextRenderable(renderer, { content: "", marginBottom: 1 });
  const panelList = new BoxRenderable(renderer, { flexDirection: "column" });
  const panelHint = new TextRenderable(renderer, { content: "", fg: color.subtle, marginTop: 1 });
  panelBox.add(panelTitle);
  panelBox.add(panelList);
  panelBox.add(panelHint);
  const attachmentLine = new TextRenderable(renderer, {
    content: "",
    fg: color.accent,
    flexShrink: 0,
    visible: false,
  });
  const queueBox = new TextRenderable(renderer, {
    content: "",
    paddingLeft: 1,
    flexShrink: 0,
    visible: false,
  });
  const composerBox = new BoxRenderable(renderer, {
    flexDirection: "row",
    border: true,
    borderStyle: "rounded",
    borderColor: color.subtle,
    paddingLeft: 1,
    minHeight: 3,
    flexShrink: 0,
  });
  const prompt = new TextRenderable(renderer, { content: "", flexShrink: 0 });
  const composer = new TextareaRenderable(renderer, {
    minHeight: 1,
    maxHeight: 10,
    flexGrow: 1,
    textColor: color.text,
    focusedTextColor: color.text,
    placeholder: "Message the agent, or / for commands",
    placeholderColor: color.subtle,
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "return", meta: true, action: "newline" },
      { name: "j", ctrl: true, action: "newline" },
    ],
    onSubmit: () => submit(),
    onContentChange: () => {
      // The event arrives after the edit, so edits made here are told apart by their text.
      if (composer.plainText === composerText) return;
      composerText = composer.plainText;
      // Typing filters a picker and narrows the command list from the top.
      if (picker !== null || composer.plainText.startsWith("/")) selected = 0;
      historyIndex = null;
      redraw();
    },
  });
  const footer = new TextRenderable(renderer, { content: "", paddingLeft: 1, flexShrink: 0 });

  composerBox.add(prompt);
  composerBox.add(composer);
  root.add(header);
  root.add(scroll);
  root.add(panelBox);
  root.add(queueBox);
  root.add(attachmentLine);
  root.add(composerBox);
  root.add(footer);
  renderer.root.add(root);
  composer.focus();

  const timeline = makeTimeline(renderer, scroll);
  let current: SessionView | null = null;
  let picker: Picker<PickerValue> | null = null;
  let pickerDraft = "";
  let selected = 0;
  let verbose = false;
  let localNotice: string | null = null;
  let quitting = false;
  let attachments: ReadonlyArray<UploadChatImageAttachment> = [];
  let question: QuestionDraft | null = null;
  let approvalId: string | null = null;
  // The queued message the composer is rewriting, if any.
  let editingQueued: QueuedMessage | null = null;
  // Index into the thread's own messages while browsing them with ↑↓; null while editing.
  let historyIndex: number | null = null;

  // Edits made here are not typing, so they keep the selection and the history position.
  let composerText = "";
  const setComposer = (text: string) => {
    composerText = text;
    composer.setText(text);
    composer.gotoBufferEnd();
  };

  const openPicker = (next: Picker<PickerValue>) => {
    if (picker === null) pickerDraft = composer.plainText.startsWith("/") ? "" : composer.plainText;
    picker = next;
    setComposer("");
    selected = next.initial ?? 0;
    redraw();
  };

  const closePicker = () => {
    picker = null;
    setComposer(pickerDraft);
    pickerDraft = "";
    selected = 0;
    redraw();
  };

  const notify = (text: string) => {
    localNotice = text;
    redraw();
  };

  const lastReply = () =>
    current?.rows.findLast((row) => row.tone === "assistant" && row.text.trim().length > 0)?.text;

  const runCommand = (name: SlashCommandName) => {
    setComposer("");
    switch (name) {
      case "new":
        return actions.newThread();
      case "threads":
        return actions.listThreads();
      case "model": {
        const models = actions.models();
        const now = current?.model;
        return openPicker({
          title: "Model for the next message",
          items: models.map((choice) => ({
            label: choice.model,
            detail: choice.provider,
            value: { type: "model", selection: choice.selection },
          })),
          initial: Math.max(
            0,
            models.findIndex(
              (choice) =>
                choice.selection.instanceId === now?.instanceId &&
                choice.selection.model === now.model,
            ),
          ),
        });
      }
      case "mode":
        return openPicker({
          title: "Permission mode",
          items: RUNTIME_MODES.map((entry) => ({
            label: entry.label,
            detail: entry.description,
            value: { type: "mode", mode: entry.mode },
          })),
          initial: Math.max(
            0,
            RUNTIME_MODES.findIndex((entry) => entry.mode === current?.runtimeMode),
          ),
        });
      case "plan":
        return actions.togglePlanMode();
      case "implement":
        return actions.implementPlan();
      case "verbose":
        verbose = !verbose;
        timeline.setVerbose(verbose);
        actions.setVerbose(verbose);
        return notify(verbose ? "Showing thinking and tool output" : "Hiding details");
      case "copy": {
        const reply = lastReply();
        if (reply === undefined) return notify("No reply to copy yet");
        return notify(
          renderer.copyToClipboardOSC52(reply)
            ? "Copied the last reply"
            : "This terminal does not allow copying",
        );
      }
      case "stop":
        return actions.interrupt();
      case "help":
        return openPicker({
          title: `Commands\n${HELP_KEYS}`,
          items: SLASH_COMMANDS.map((command) => ({
            label: `/${command.name}`,
            detail: command.key ? `${command.description}  (${command.key})` : command.description,
            value: { type: "command", name: command.name },
          })),
        });
      case "queue": {
        const queue = current?.queue ?? [];
        if (queue.length === 0 && !current?.queueHeld) return notify("Nothing is queued");
        return openPicker({
          title: "Queued messages",
          items: [
            ...queue.map((message, index) => ({
              label: `${index + 1}. ${oneLine(message.text)}`,
              value: { type: "queued" as const, message },
            })),
            ...(current?.queueHeld
              ? [
                  {
                    label: "Resume the queue",
                    detail: "it is paused",
                    value: { type: "queue" as const, action: { type: "resume" as const } },
                  },
                ]
              : []),
          ],
        });
      }
      case "quit":
        quitting = true;
        return actions.exit();
    }
  };

  const queuedActions = (message: QueuedMessage): Picker<PickerValue> => ({
    title: `Queued: ${oneLine(message.text)}`,
    items: [
      // A turn waiting on an approval or a question cannot take a steer.
      ...(current?.canSteerQueued && current.approval === null && current.question === null
        ? [
            {
              label: "Send now",
              detail: "steer the running turn with it",
              value: {
                type: "queue" as const,
                action: { type: "steer" as const, runId: message.runId },
              },
            },
          ]
        : []),
      {
        label: "Edit",
        detail: "rewrite it in the message box",
        value: { type: "queue" as const, action: { type: "edit-draft" as const, message } },
      },
      {
        label: "Remove",
        detail: "take it out of the queue",
        value: {
          type: "queue" as const,
          action: { type: "cancel" as const, runId: message.runId },
        },
      },
    ],
  });

  const choose = (value: PickerValue) => {
    picker = null;
    setComposer(pickerDraft);
    pickerDraft = "";
    selected = 0;
    switch (value.type) {
      case "model":
        actions.setModel(value.selection);
        break;
      case "mode":
        actions.setRuntimeMode(value.mode);
        break;
      case "thread":
        actions.openThread(value.id);
        break;
      case "command":
        runCommand(value.name);
        break;
      case "queued":
        openPicker(queuedActions(value.message));
        break;
      case "queue":
        if (value.action.type === "edit-draft") {
          editingQueued = value.action.message;
          setComposer(value.action.message.text);
        } else {
          actions.manageQueued(value.action);
        }
        break;
    }
    redraw();
  };

  const activeQuestion = () => {
    const pending = current?.question ?? null;
    if (pending === null || pending.responseMode === "message") return null;
    if (question?.requestId !== pending.requestId) {
      question = startQuestionDraft(pending);
      selected = 0;
    }
    return { pending, draft: question };
  };

  const activeApproval = () => {
    const approval = current?.approval ?? null;
    if (approval !== null && approvalId !== approval.requestId) {
      approvalId = approval.requestId;
      selected = 0;
    }
    return approval;
  };

  /** The panel that owns ↑↓ and enter right now, most specific first. */
  const panel = (): Panel | null => {
    const text = composer.plainText;
    if (picker !== null) return pickerPanel(picker, text, selected);
    const slash = slashPanel(text, selected);
    if (slash !== null) return slash;
    const asked = activeQuestion();
    if (asked !== null) return questionPanel(asked.pending, asked.draft, selected);
    if (current?.question?.responseMode === "message") {
      return questionPanel(current.question, startQuestionDraft(current.question), 0);
    }
    const approval = activeApproval();
    if (approval !== null) return approvalPanel(approval, selected);
    return null;
  };

  const answerQuestion = (action: Parameters<typeof stepQuestion>[2]) => {
    const asked = activeQuestion();
    if (asked === null) return;
    const step = stepQuestion(asked.pending, asked.draft, action);
    if (step.type === "submit") {
      actions.answerQuestion(asked.pending.requestId, step.answers);
      question = null;
    } else {
      if (step.draft.index !== asked.draft.index) selected = 0;
      question = step.draft;
      if (step.type === "incomplete") localNotice = "Answer every question first";
    }
    if (action.type === "choose") setComposer("");
    redraw();
  };

  const decideApproval = (index: number) => {
    const approval = activeApproval();
    if (approval === null) return;
    const decision = approvalDecision(approval, index);
    const typed = composer.plainText.trim();
    const feedback =
      approval.supportsFeedback &&
      typed.length > 0 &&
      (decision === "decline" || decision === "cancel")
        ? typed
        : null;
    if (feedback !== null) setComposer("");
    actions.answerApproval(approval.requestId, decision, feedback);
  };

  const sendDraft = (queue: boolean) => {
    const text = composer.plainText.trim();
    if (text.length === 0 && attachments.length === 0) return;
    const images = attachments;
    attachments = [];
    setComposer("");
    actions.send(text, images, queue);
    redraw();
  };

  function submit() {
    const command = parseSlashCommand(composer.plainText);
    if (command !== null) return runCommand(command);
    if (editingQueued !== null) {
      const text = composer.plainText.trim();
      if (text.length === 0) return;
      actions.manageQueued({ type: "edit", runId: editingQueued.runId, text });
      editingQueued = null;
      setComposer("");
      return redraw();
    }
    sendDraft(false);
  }

  const userMessages = () =>
    (current?.rows ?? []).filter((row) => row.tone === "user").map((row) => row.text);

  const browseHistory = (direction: -1 | 1) => {
    const messages = userMessages();
    if (messages.length === 0) return false;
    const next =
      historyIndex === null
        ? direction === -1
          ? messages.length - 1
          : null
        : historyIndex + direction;
    if (next === null) return false;
    if (next >= messages.length) {
      setComposer("");
      historyIndex = null;
      return true;
    }
    const index = Math.max(0, next);
    setComposer(messages[index]!);
    historyIndex = index;
    return true;
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    const empty = composer.plainText.length === 0;
    const handled = (run?: () => void) => {
      key.preventDefault();
      run?.();
      redraw();
    };
    localNotice = null;

    // Quitting tears the renderer down, so nothing may draw after it.
    const quit = () => {
      key.preventDefault();
      quitting = true;
      actions.exit();
    };
    if (key.ctrl && key.name === "d") return quit();
    if (key.ctrl && key.name === "c") {
      if (picker !== null) closePicker();
      else if (!empty) setComposer("");
      else if (current?.running) actions.interrupt();
      else return quit();
      return handled();
    }
    if (key.ctrl && key.name === "n") return handled(() => runCommand("new"));
    if (key.ctrl && key.name === "t") return handled(() => runCommand("threads"));
    if (key.ctrl && key.name === "l") return handled(() => runCommand("model"));
    if (key.ctrl && key.name === "o") return handled(() => runCommand("verbose"));
    if (key.name === "tab" && key.shift) return handled(() => runCommand("plan"));

    const shown = panel();
    const moves = shown !== null && shown.rows.length > 0;
    if (moves && (key.name === "up" || key.name === "down")) {
      if (picker !== null || composer.plainText.startsWith("/") || empty) {
        selected = clampSelection(selected + (key.name === "up" ? -1 : 1), shown.rows.length);
        return handled();
      }
    }

    if (picker !== null) {
      if (key.name === "escape") return handled(() => closePicker());
      if (key.name === "return") {
        const item = filterPicker(picker, composer.plainText)[selected];
        if (item !== undefined) choose(item.value);
        return handled();
      }
      return;
    }

    const command = slashCommandAt(composer.plainText, selected);
    if (command !== null) {
      if (key.name === "tab") return handled(() => setComposer(`/${command}`));
      if (key.name === "return") return handled(() => runCommand(command));
    }

    // Rewriting a queued message owns enter, even while the agent waits on a question.
    if (editingQueued !== null && key.name === "return" && !key.shift && !key.meta) {
      return handled(() => submit());
    }

    if (activeQuestion() !== null) {
      const digit = Number.parseInt(key.name, 10);
      if (empty && digit >= 1 && digit <= 9) {
        const option = digit - 1;
        selected = option;
        const multi = activeQuestion()!.pending.questions[question!.index]?.multiSelect === true;
        answerQuestion(multi ? { type: "toggle", option } : { type: "choose", option, typed: "" });
        return handled();
      }
      if (empty && key.name === "space") {
        return handled(() => answerQuestion({ type: "toggle", option: selected }));
      }
      if (empty && key.name === "left") return handled(() => answerQuestion({ type: "back" }));
      if (key.name === "return") {
        return handled(() =>
          answerQuestion({
            type: "choose",
            option: selected,
            typed: composer.plainText,
          }),
        );
      }
      if (key.name === "escape" && current?.question?.dismissible) {
        actions.answerQuestion(current.question.requestId, null);
        question = null;
        return handled();
      }
    } else if (activeApproval() !== null) {
      const digit = Number.parseInt(key.name, 10);
      if (empty && digit >= 1 && digit <= 9 && shown !== null && digit <= shown.rows.length) {
        return handled(() => decideApproval(digit - 1));
      }
      if (key.name === "return") return handled(() => decideApproval(selected));
    }

    if (key.name === "escape" && editingQueued !== null) {
      return handled(() => {
        editingQueued = null;
        setComposer("");
      });
    }
    if (key.name === "escape" && current?.running) return handled(() => actions.interrupt());
    if (key.name === "tab" && (!empty || attachments.length > 0) && current?.running) {
      return handled(() => sendDraft(true));
    }
    if (key.ctrl && key.name === "v") return handled(() => actions.pasteImage());
    if (key.name === "backspace" && empty && attachments.length > 0) {
      return handled(() => {
        attachments = attachments.slice(0, -1);
      });
    }
    if ((key.name === "up" || key.name === "down") && (empty || historyIndex !== null)) {
      if (browseHistory(key.name === "up" ? -1 : 1)) return handled();
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      const page = Math.max(1, scroll.height - 2);
      if (key.name === "pageup" && scroll.scrollTop <= 0 && current?.hasEarlierHistory) {
        actions.loadEarlier();
        localNotice = "Loading earlier messages…";
      }
      scroll.scrollBy(key.name === "pageup" ? -page : page);
      return handled();
    }
  });

  // A dragged file arrives as a pasted path; an image path becomes an attachment.
  renderer.keyInput.on("paste", (event) => {
    const paths = pastedImagePaths(new TextDecoder().decode(event.bytes));
    if (paths === null) return;
    event.preventDefault();
    actions.attachImages(paths);
  });

  const renderPanel = (shown: Panel | null) => {
    panelBox.visible = shown !== null;
    if (shown === null) return;
    const [titleLine = "", ...titleRest] = shown.title.split("\n");
    panelTitle.content = styled([
      { text: titleLine, fg: color.accent, bold: true },
      ...(titleRest.length > 0 ? [{ text: `\n${titleRest.join("\n")}`, fg: color.muted }] : []),
    ]);
    for (const child of panelList.getChildren()) {
      panelList.remove(child);
      child.destroyRecursively();
    }
    // A window of rows around the selection keeps long lists from pushing the chat away.
    const start = Math.max(
      0,
      Math.min(
        shown.selected - Math.floor(PANEL_VISIBLE_ROWS / 2),
        shown.rows.length - PANEL_VISIBLE_ROWS,
      ),
    );
    const visible = shown.rows.slice(start, start + PANEL_VISIBLE_ROWS);
    visible.forEach((row, offset) => {
      const isSelected = start + offset === shown.selected && shown.rows.length > 0;
      const line = new BoxRenderable(renderer, {
        ...(isSelected ? { backgroundColor: color.selection } : {}),
        paddingLeft: 1,
        paddingRight: 1,
      });
      line.add(
        new TextRenderable(renderer, {
          content: styled([
            { text: isSelected ? "❯ " : "  ", fg: color.accent, bold: true },
            ...(row.mark ? [{ text: `${row.mark} `, fg: color.accent }] : []),
            { text: row.label, fg: isSelected ? color.user : color.text, bold: isSelected },
            ...(row.detail ? [{ text: `  ${row.detail}`, fg: color.muted }] : []),
          ]),
        }),
      );
      panelList.add(line);
    });
    const hidden = shown.rows.length - visible.length;
    panelHint.content = hidden > 0 ? `${shown.hint} · ${hidden} more` : shown.hint;
  };

  function redraw() {
    if (current === null || quitting) return;
    const view = current;
    headerTitle.content = styled([
      { text: view.threadTitle ?? "New thread", fg: color.user, bold: true },
      ...(view.connection === "connected"
        ? []
        : [{ text: `  ${view.connection}`, fg: color.warning }]),
    ]);
    headerProject.content = view.projectTitle;
    headerLocation.content = view.location;
    const shown = panel();
    renderPanel(shown);
    panelBox.borderColor =
      view.approval !== null || view.question !== null ? color.warning : color.accent;

    queueBox.visible = view.queue.length > 0 || view.queueHeld;
    queueBox.content = styled([
      {
        text: view.queueHeld ? "Queue paused" : `Queued (${view.queue.length})`,
        fg: color.warning,
        bold: true,
      },
      { text: "  /queue to send now, edit, or remove", fg: color.subtle },
      ...view.queue.flatMap((message, index): Segment[] => [
        { text: `\n  ${index + 1}  `, fg: color.subtle },
        { text: oneLine(message.text), fg: color.muted },
      ]),
    ]);

    attachmentLine.visible = attachments.length > 0;
    attachmentLine.content = `${attachments
      .map(
        (image) => `[image: ${image.name}, ${Math.max(1, Math.round(image.sizeBytes / 1024))} KB]`,
      )
      .join("  ")}   backspace removes`;

    const plan = view.interactionMode === "plan";
    prompt.content = styled([
      editingQueued !== null
        ? { text: "✎ ", fg: color.warning, bold: true }
        : { text: "❯ ", fg: plan ? color.success : color.accent, bold: true },
    ]);
    composerBox.borderColor =
      editingQueued !== null
        ? color.warning
        : plan
          ? color.success
          : view.running
            ? color.accent
            : color.subtle;

    const waiting = view.question !== null || view.approval !== null;
    const notice = localNotice ?? view.notice;
    const chip = (text: string, background: string): Segment => ({
      text: ` ${text} `,
      fg: color.surface,
      bg: background,
      bold: true,
    });
    const gap: Segment = { text: "  " };
    footer.content = styled(
      [
        editingQueued !== null
          ? [
              chip("EDITING QUEUED", color.warning),
              { text: "  enter saves · esc cancels", fg: color.subtle },
            ]
          : waiting
            ? [chip("WAITING FOR YOU", color.warning)]
            : view.running
              ? [
                  chip("WORKING", color.accent),
                  { text: "  esc stop · tab queue", fg: color.subtle },
                ]
              : [],
        plan ? [chip("PLAN", color.success)] : [],
        view.planReady && plan ? [{ text: "/implement to build it", fg: color.success }] : [],
        [{ text: view.modelLabel, fg: color.purple }],
        [{ text: runtimeModeLabel(view.runtimeMode), fg: color.muted }],
        view.contextUsedPercent === null ? [] : [contextMeter(view.contextUsedPercent)],
        verbose ? [{ text: "verbose", fg: color.muted }] : [],
        notice ? [{ text: notice, fg: color.warning }] : [],
        [{ text: "/help", fg: color.subtle }],
      ]
        .filter((part) => part.length > 0)
        .flatMap((part, index) => (index === 0 ? part : [gap, ...part])),
    );
  }

  return {
    notify,
    addAttachments: (images: ReadonlyArray<UploadChatImageAttachment>) => {
      attachments = [...attachments, ...images];
      redraw();
    },
    render: (view: SessionView) => {
      if (current?.threadId !== view.threadId) {
        question = null;
        approvalId = null;
        historyIndex = null;
      }
      current = view;
      timeline.render(view.rows);
      redraw();
    },
    showThreads: (threads: ReadonlyArray<ThreadChoice>, now: number) =>
      openPicker({
        title: "Threads in this folder",
        items: threads.map((thread) => ({
          label: thread.title,
          detail: `${thread.status === "idle" ? "" : `${thread.status} · `}${formatAge(thread.lastActiveAt, now)}`,
          value: { type: "thread", id: thread.id },
        })),
        initial: Math.max(
          0,
          threads.findIndex((thread) => thread.id === current?.threadId),
        ),
      }),
  };
}
