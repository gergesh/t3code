import {
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type RunId,
  type RuntimeRequestId,
  type ServerProvider,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import {
  createProject,
  deriveThreadTitleSeed,
  dismissThreadUserInput,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  cancelQueuedRun,
  editQueuedRun,
  promoteQueuedRun,
  resumeThreadQueue,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  startThreadTurn,
} from "@t3tools/client-runtime/operations";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { getInitialServerConfig, request, subscribe } from "@t3tools/client-runtime/rpc";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  ThreadHistoryController,
  ThreadSnapshotLoader,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import {
  derivePendingThreadRequests,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { activeRun, timelineRows, type TimelineRow } from "./timeline.ts";

/** Where a thread for the working directory belongs, decided by the caller who can read git. */
export interface WorkspaceResolution {
  readonly projectId: ProjectId | null;
  /** Set when the directory is a git worktree of the project rather than its own checkout. */
  readonly worktreePath: string | null;
}

export type ResolveWorkspace = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
) => Effect.Effect<WorkspaceResolution>;

export interface SessionOptions {
  readonly cwd: string;
  readonly resume: boolean;
  readonly modelSelection: ModelSelection | null;
  readonly resolveWorkspace: ResolveWorkspace;
}

export interface ModelChoice {
  readonly selection: ModelSelection;
  readonly provider: string;
  readonly model: string;
}

export interface ThreadChoice {
  readonly id: ThreadId;
  readonly title: string;
  readonly status: OrchestrationV2ThreadShell["status"];
  readonly lastActiveAt: number;
}

export type QueueAction =
  | { readonly type: "steer"; readonly runId: RunId }
  | { readonly type: "cancel"; readonly runId: RunId }
  | { readonly type: "edit"; readonly runId: RunId; readonly text: string }
  | { readonly type: "resume" };

export interface QueuedMessage {
  readonly runId: RunId;
  readonly text: string;
}

export interface SessionView {
  readonly connection: string;
  readonly projectTitle: string;
  readonly location: string;
  readonly model: ModelSelection;
  readonly modelLabel: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly threadId: ThreadId | null;
  readonly threadTitle: string | null;
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly running: boolean;
  /** Messages waiting for the running turn, in the order they will run. */
  readonly queue: ReadonlyArray<QueuedMessage>;
  /** The queue is paused, so nothing in it starts until it is resumed. */
  readonly queueHeld: boolean;
  /** A queued message can steer the running turn instead of waiting for it. */
  readonly canSteerQueued: boolean;
  readonly approval: ThreadPendingApproval | null;
  readonly question: ThreadPendingUserInput | null;
  /** The proposed plan `/implement` would build, when the thread has one. */
  readonly planReady: boolean;
  readonly contextUsedPercent: number | null;
  readonly hasEarlierHistory: boolean;
  readonly notice: string | null;
}

type SessionServices =
  | EnvironmentSupervisor.EnvironmentSupervisor
  | SecureRandom.SecureRandom
  | Persistence.EnvironmentCacheStore
  | ThreadSnapshotLoader;

const uuid = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4());

const IMPLEMENT_PLAN_MESSAGE = "Implement the plan.";

const firstShellSnapshot = subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}).pipe(
  Stream.filter((item) => item.kind === "snapshot"),
  Stream.map((item) => item.snapshot),
  Stream.runHead,
  Effect.flatMap((snapshot) =>
    Option.match(snapshot, {
      onNone: () => Effect.die(new Error("The server ended the shell stream without a snapshot.")),
      onSome: Effect.succeed,
    }),
  ),
);

const lastActiveAt = (thread: OrchestrationV2ThreadShell) =>
  DateTime.toEpochMillis(thread.latestUserMessageAt ?? thread.createdAt);

/** The folder's own threads, newest first; subagents and archived threads stay out. */
const threadsAt = (
  snapshot: OrchestrationV2ShellSnapshot,
  projectId: ProjectId,
  worktreePath: string | null,
): ThreadChoice[] =>
  snapshot.threads
    .filter(
      (thread) =>
        thread.projectId === projectId &&
        thread.worktreePath === worktreePath &&
        thread.delegatedFrom === undefined &&
        thread.archivedAt === null,
    )
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      status: thread.status,
      lastActiveAt: lastActiveAt(thread),
    }))
    .toSorted((left, right) => right.lastActiveAt - left.lastActiveAt);

function usableProviders(providers: ReadonlyArray<ServerProvider>) {
  return providers.filter(
    (provider) =>
      provider.enabled && provider.installed && provider.auth.status !== "unauthenticated",
  );
}

/** What a new thread runs with when neither the project nor the settings name a model. */
function firstAvailableModel(providers: ReadonlyArray<ServerProvider>): ModelSelection | null {
  for (const provider of usableProviders(providers)) {
    const model = provider.models.find((entry) => entry.isDefault) ?? provider.models[0];
    if (model !== undefined) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}

function modelLabel(selection: ModelSelection, providers: ReadonlyArray<ServerProvider>) {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  return `${provider?.displayName ?? selection.instanceId} · ${model?.name ?? selection.model}`;
}

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId && left.model === right.model;

function contextUsedPercent(projection: OrchestrationV2ThreadProjection): number | null {
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const usage = latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread);
  return (
    deriveLatestContextWindowSnapshot(projection.visibleTurnItems, usage, providerThread)
      ?.usedPercentage ?? null
  );
}

/** One readable line for a failed action: the error's own message, not the cause's dump. */
function failureText(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
  return message.trim().split("\n")[0] || "That did not work.";
}

function queueView(projection: OrchestrationV2ThreadProjection) {
  const queue = deriveThreadQueueWorkflowState(projection);
  return {
    queue: queue.queuedRuns.map(({ run, text }) => ({ runId: run.id, text })),
    queueHeld: queue.isHeld,
    canSteerQueued: queue.canPromoteToSteer,
  };
}

const activePlan = (projection: OrchestrationV2ThreadProjection) =>
  projection.plans.findLast((plan) => plan.kind === "proposed_plan" && plan.status === "active");

/**
 * The working directory's threads: the project is found on start and added by the
 * first message, and a new thread is created by its first message, so an unused
 * session leaves nothing behind.
 */
export const makeSession = Effect.fn("TuiSession.make")(function* (
  options: SessionOptions,
  onChange: (view: SessionView) => void,
) {
  const scope = yield* Scope.Scope;
  // The view calls in from key handlers, so each call carries the services it needs.
  const services = yield* Effect.context<SessionServices>();
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const history = yield* ThreadHistoryController.ThreadHistoryController;
  const environmentId = supervisor.target.environmentId;

  // Requests before the first session would fail rather than wait for it.
  const waitForSession = SubscriptionRef.changes(supervisor.session).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
  );

  let view: SessionView | null = null;
  const pendingPatches: Array<Partial<SessionView>> = [];
  const update = (patch: Partial<SessionView>) => {
    if (view === null) {
      pendingPatches.push(patch);
      return;
    }
    view = { ...view, ...patch };
    onChange(view);
  };

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((state) =>
      Effect.sync(() =>
        update({
          connection:
            state.phase === "connected"
              ? "connected"
              : state.phase === "backoff"
                ? "reconnecting"
                : state.phase,
          ...((state.phase === "blocked" || state.phase === "backoff") && state.lastFailure !== null
            ? { notice: state.lastFailure.detail }
            : {}),
        }),
      ),
    ),
    Effect.forkIn(scope),
  );

  yield* waitForSession;
  const config = yield* getInitialServerConfig();
  const snapshot = yield* firstShellSnapshot;
  const resolution = yield* options.resolveWorkspace(snapshot.projects);
  const existing = snapshot.projects.find((project) => project.id === resolution.projectId);
  const projectId = existing?.id ?? ProjectId.make(yield* uuid);
  let projectCreated = existing !== undefined;
  const worktreePath = existing === undefined ? null : resolution.worktreePath;
  const defaultModel =
    options.modelSelection ??
    existing?.defaultModelSelection ??
    config.settings.defaultModelSelection ??
    firstAvailableModel(config.providers);
  if (defaultModel === null) {
    return yield* Effect.die(
      new Error("No provider is ready. Sign in to one in T3 Code settings, then retry."),
    );
  }
  const defaultRuntimeMode = config.settings.defaultRuntimeMode;

  const blankThread = (): Partial<SessionView> => ({
    threadId: null,
    threadTitle: null,
    rows: [],
    running: false,
    queue: [],
    queueHeld: false,
    canSteerQueued: false,
    approval: null,
    question: null,
    planReady: false,
    contextUsedPercent: null,
    hasEarlierHistory: false,
    model: chosenModel ?? defaultModel,
    modelLabel: modelLabel(chosenModel ?? defaultModel, config.providers),
    runtimeMode: chosenRuntimeMode ?? defaultRuntimeMode,
    interactionMode: chosenInteractionMode ?? "default",
  });

  // Choices made before a thread exists, applied when its first message creates it.
  let chosenModel: ModelSelection | null = null;
  let chosenRuntimeMode: RuntimeMode | null = null;
  let chosenInteractionMode: ProviderInteractionMode | null = null;

  view = {
    connection: "connected",
    projectTitle: existing?.title ?? inferProjectTitleFromPath(options.cwd),
    location: worktreePath ?? existing?.workspaceRoot ?? options.cwd,
    notice: null,
    ...(blankThread() as Omit<SessionView, "connection" | "projectTitle" | "location" | "notice">),
  };
  for (const patch of pendingPatches.splice(0)) view = { ...view, ...patch };
  onChange(view);

  let threadId: ThreadId | null = null;
  let projection: OrchestrationV2ThreadProjection | null = null;
  let threadScope: Scope.Closeable | null = null;

  const leaveThread = Effect.gen(function* () {
    if (threadScope !== null) yield* Scope.close(threadScope, Exit.void);
    threadScope = null;
    threadId = null;
    projection = null;
    lastState = null;
    fullItems.clear();
    requested.clear();
  });

  // Verbose mode shows output the thread stream leaves out, fetched once per item revision.
  let verbose = false;
  let lastState: EnvironmentThreadState | null = null;
  const fullItems = new Map<string, OrchestrationV2TurnItem>();
  const requested = new Map<string, string>();

  const fetchDetails = (next: OrchestrationV2ThreadProjection) => {
    const id = threadId;
    const owner = threadScope;
    if (!verbose || id === null || owner === null) return;
    for (const { item } of next.visibleTurnItems) {
      const revision = turnItemDetailRevision(item);
      if (!turnItemNeedsDetailFetch(item) || requested.get(item.id) === revision) continue;
      requested.set(item.id, revision);
      const fetch = request(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
        threadId: id,
        itemId: item.id,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() => {
            if (threadId !== id || result.item === null) return;
            fullItems.set(item.id, result.item);
            if (lastState !== null) render(lastState);
          }),
        ),
        Effect.ignore,
      );
      Effect.runForkWith(services)(Effect.forkIn(fetch, owner));
    }
  };

  const render = (state: EnvironmentThreadState) => {
    lastState = state;
    if (Option.isNone(state.data)) return;
    const next = state.data.value;
    projection = next;
    fetchDetails(next);
    const pending = derivePendingThreadRequests(next);
    const model = chosenModel ?? next.thread.modelSelection;
    update({
      threadTitle: next.thread.title,
      rows: timelineRows(next, fullItems),
      running: activeRun(next) !== null,
      ...queueView(next),
      approval: pending.approvals[0] ?? null,
      question: pending.userInputs[0] ?? null,
      planReady: activePlan(next) !== undefined,
      contextUsedPercent: contextUsedPercent(next),
      hasEarlierHistory: state.history.hasMoreHistory,
      model,
      modelLabel: modelLabel(model, config.providers),
      runtimeMode: next.thread.runtimeMode,
      interactionMode: next.thread.interactionMode,
      notice: Option.getOrNull(state.error),
    });
  };

  const follow = Effect.fn("TuiSession.follow")(function* (id: ThreadId) {
    yield* leaveThread;
    const opened = yield* Scope.fork(scope);
    threadScope = opened;
    threadId = id;
    const state = yield* makeEnvironmentThreadState(id).pipe(Scope.provide(opened));
    yield* SubscriptionRef.changes(state).pipe(
      Stream.runForEach((next) => Effect.sync(() => threadId === id && render(next))),
      Effect.forkIn(opened),
    );
  });

  const listThreads = Effect.fn("TuiSession.listThreads")(function* () {
    return {
      threads: threadsAt(yield* firstShellSnapshot, projectId, worktreePath),
      now: yield* Clock.currentTimeMillis,
    };
  });

  if (options.resume) {
    const [latest] = threadsAt(snapshot, projectId, worktreePath);
    if (latest !== undefined) yield* follow(latest.id);
    else update({ notice: "No earlier thread here; starting a new one." });
  }

  const reportFailure = <A, E>(effect: Effect.Effect<A, E, SessionServices>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.sync(() => update({ notice: failureText(cause) }))),
      Effect.provideContext(services),
    );

  const send = Effect.fn("TuiSession.send")(function* (
    text: string,
    attachments: ReadonlyArray<UploadChatImageAttachment>,
    dispatch: {
      readonly queue: boolean;
      readonly planId?: OrchestrationV2ThreadProjection["plans"][number]["id"];
    },
  ) {
    const messageId = MessageId.make(yield* uuid);
    const message = { messageId, role: "user" as const, text, attachments };
    if (threadId === null) {
      if (!projectCreated) {
        yield* createProject({
          projectId,
          title: inferProjectTitleFromPath(options.cwd),
          workspaceRoot: options.cwd,
          createWorkspaceRootIfMissing: false,
        });
        projectCreated = true;
      }
      const id = ThreadId.make(yield* uuid);
      const title = deriveThreadTitleSeed({ text, attachments });
      const modelSelection = chosenModel ?? defaultModel;
      const runtimeMode = chosenRuntimeMode ?? defaultRuntimeMode;
      const interactionMode = chosenInteractionMode ?? "default";
      yield* startThreadTurn({
        threadId: id,
        message,
        modelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          },
        },
      });
      yield* follow(id);
      return;
    }
    const current = projection;
    const running = current !== null && activeRun(current) !== null;
    const switchModel =
      chosenModel !== null &&
      (current === null || !sameModel(chosenModel, current.thread.modelSelection))
        ? chosenModel
        : undefined;
    yield* startThreadTurn({
      threadId,
      message,
      ...(switchModel === undefined ? {} : { modelSelection: switchModel }),
      runtimeMode: current?.thread.runtimeMode ?? defaultRuntimeMode,
      interactionMode:
        dispatch.planId !== undefined ? "default" : (current?.thread.interactionMode ?? "default"),
      ...(dispatch.planId === undefined
        ? {}
        : { sourceProposedPlan: { threadId, planId: dispatch.planId } }),
      dispatchMode: resolveComposerDispatchMode({ running, alternateModifier: dispatch.queue }),
    });
  });

  const interrupt = Effect.gen(function* () {
    if (threadId === null || projection === null) return;
    const run = activeRun(projection);
    if (run === null) return;
    yield* interruptThreadTurn({ threadId, runId: run.id });
  });

  const answerApproval = Effect.fn("TuiSession.answerApproval")(function* (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    feedback: string | null,
  ) {
    if (threadId === null) return;
    yield* respondToThreadApproval({
      threadId,
      requestId,
      decision,
      ...(feedback === null ? {} : { feedback }),
    });
  });

  const answerQuestion = Effect.fn("TuiSession.answerQuestion")(function* (
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers | null,
  ) {
    if (threadId === null) return;
    yield* answers === null
      ? dismissThreadUserInput({ threadId, requestId })
      : respondToThreadUserInput({ threadId, requestId, answers });
  });

  const setModel = (selection: ModelSelection) =>
    Effect.sync(() => {
      chosenModel = selection;
      update({ model: selection, modelLabel: modelLabel(selection, config.providers) });
    });

  const setRuntimeMode = Effect.fn("TuiSession.setRuntimeMode")(function* (mode: RuntimeMode) {
    if (threadId === null) {
      chosenRuntimeMode = mode;
      update({ runtimeMode: mode });
      return;
    }
    yield* setThreadRuntimeMode({ threadId, runtimeMode: mode });
  });

  const setInteractionMode = Effect.fn("TuiSession.setInteractionMode")(function* (
    mode: ProviderInteractionMode,
  ) {
    if (threadId === null) {
      chosenInteractionMode = mode;
      update({ interactionMode: mode });
      return;
    }
    yield* setThreadInteractionMode({ threadId, interactionMode: mode });
  });

  const implementPlan = Effect.gen(function* () {
    const plan = projection === null ? undefined : activePlan(projection);
    if (plan === undefined) {
      update({ notice: "This thread has no proposed plan to implement." });
      return;
    }
    yield* send(IMPLEMENT_PLAN_MESSAGE, [], { queue: false, planId: plan.id });
  });

  const manageQueued = Effect.fn("TuiSession.manageQueued")(function* (action: QueueAction) {
    if (threadId === null) return;
    switch (action.type) {
      case "steer": {
        const target = projection === null ? null : activeRun(projection);
        if (target === null) {
          update({ notice: "Nothing is running to steer; the message runs next." });
          return;
        }
        yield* promoteQueuedRun({ threadId, queuedRunId: action.runId, targetRunId: target.id });
        return;
      }
      case "cancel":
        yield* cancelQueuedRun({ threadId, runId: action.runId });
        return;
      case "edit":
        yield* editQueuedRun({ threadId, runId: action.runId, text: action.text });
        return;
      case "resume":
        yield* resumeThreadQueue({ threadId });
        return;
    }
  });

  const newThread = Effect.gen(function* () {
    yield* leaveThread;
    chosenInteractionMode = null;
    update({ ...blankThread(), notice: null });
  });

  const loadEarlier = Effect.gen(function* () {
    if (threadId === null) return;
    const result = yield* history.loadEarlier(environmentId, threadId);
    if (result._tag === "error") update({ notice: result.message });
  });

  const models = (): ReadonlyArray<ModelChoice> =>
    usableProviders(config.providers).flatMap((provider) =>
      provider.models.map((model) => ({
        selection: { instanceId: provider.instanceId, model: model.slug },
        provider: provider.displayName ?? provider.instanceId,
        model: model.name,
      })),
    );

  return {
    send: (text: string, attachments: ReadonlyArray<UploadChatImageAttachment>, queue: boolean) =>
      reportFailure(send(text, attachments, { queue })),
    interrupt: reportFailure(interrupt),
    answerApproval: (
      requestId: RuntimeRequestId,
      decision: ProviderApprovalDecision,
      feedback: string | null,
    ) => reportFailure(answerApproval(requestId, decision, feedback)),
    answerQuestion: (requestId: RuntimeRequestId, answers: ProviderUserInputAnswers | null) =>
      reportFailure(answerQuestion(requestId, answers)),
    setModel: (selection: ModelSelection) => reportFailure(setModel(selection)),
    setRuntimeMode: (mode: RuntimeMode) => reportFailure(setRuntimeMode(mode)),
    setInteractionMode: (mode: ProviderInteractionMode) => reportFailure(setInteractionMode(mode)),
    togglePlanMode: reportFailure(
      Effect.suspend(() =>
        setInteractionMode(view?.interactionMode === "plan" ? "default" : "plan"),
      ),
    ),
    implementPlan: reportFailure(implementPlan),
    manageQueued: (action: QueueAction) => reportFailure(manageQueued(action)),
    newThread: reportFailure(newThread),
    // A model picked here follows new threads, but an opened thread keeps its own.
    openThread: (id: ThreadId) =>
      reportFailure(
        Effect.suspend(() => {
          chosenModel = null;
          return follow(id);
        }),
      ),
    listThreads: () => listThreads().pipe(Effect.provideContext(services)),
    loadEarlier: reportFailure(loadEarlier),
    models,
    setVerbose: (next: boolean) =>
      Effect.sync(() => {
        verbose = next;
        if (lastState !== null) render(lastState);
      }),
  };
});

export type Session = Effect.Success<ReturnType<typeof makeSession>>;
