import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { VcsStatusLocalResult } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { v2ThreadShell } from "@t3tools/client-runtime/state/orchestration-v2-test-fixtures";

const state = vi.hoisted(() => ({
  status: vi.fn(),
  threadShell: vi.fn(),
  threadCommit: vi.fn(),
  reviewCommit: vi.fn(),
  reviewSections: vi.fn(() => ({
    error: null,
    reviewSections: [],
    selectedSection: null,
    refreshSelectedSection: async () => {},
    selectSection: () => {},
    isSelectedSectionPending: false,
    diffPreviewRevision: 0,
  })),
}));

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
// Mock factories run before static imports initialize, so load their React/atom dependencies here.
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsActionManager: () => ({}),
}));

// Keep pure state, review derivation, and runnable UI real; isolate connection and native seams.
vi.mock("react-native", () => {
  const Surface = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: ({
      children,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
    }) => <div aria-label={accessibilityLabel}>{children}</div>,
    Text: ({
      children,
      accessibilityRole,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
    }) => <span role={accessibilityRole}>{children}</span>,
    ActivityIndicator: () => null,
    ScrollView: Surface,
    FlatList: () => null,
    Pressable: Surface,
    RefreshControl: () => null,
    Platform: { OS: "ios", select: (values: { ios?: unknown }) => values.ios },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    Keyboard: { dismiss: () => {} },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock("react-native-screens", () => ({
  Screen: () => null,
  ScreenStack: () => null,
  ScreenStackHeaderConfig: () => null,
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useNavigation: () => ({ navigate: () => {}, canGoBack: () => false }),
    useIsFocused: () => true,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
vi.mock("@react-navigation/elements", async () => {
  const { createContext } = await import("react");
  return { HeaderHeightContext: createContext(44) };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => {} }));
vi.mock("../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: async () => {} },
  KeyboardStickyView: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useKeyboardState: (select: (value: { isVisible: boolean; height: number }) => unknown) =>
    select({ isVisible: false, height: 0 }),
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  function useSharedValue<T>(value: T) {
    return useRef({
      value,
      set(next: T) {
        this.value = next;
      },
    }).current;
  }
  function useDerivedValue<T>(derive: () => T) {
    return useSharedValue(derive());
  }
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <>{children}</> },
    Easing: { out: () => {}, cubic: () => {} },
    FadeInDown: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
    ReduceMotion: { System: "system" },
    useReducedMotion: () => false,
    useSharedValue,
    useDerivedValue,
    useAnimatedStyle: (derive: () => unknown) => derive(),
    useAnimatedReaction: () => {},
    withTiming: (value: number) => value,
  };
});
vi.mock("@legendapp/list/keyboard", async () => {
  const { useRef } = await import("react");
  return {
    useKeyboardChatComposerInset: () => ({
      contentInsetEndAdjustment: { value: 0 },
      onComposerLayout: () => {},
    }),
    // The native hook retains its freeze SharedValue across renders. A fresh
    // object would retrigger ThreadDetailScreen's unrelated thread-reset effect.
    useKeyboardScrollToEnd: () =>
      useRef({ freeze: { set: () => {} }, scrollMessageToEnd: async () => {} }).current,
  };
});
vi.mock("../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../connection/catalog", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      retryNow: {
        label: "retry connection",
        run: vi.fn(async () => AsyncResult.success(undefined)),
      },
    },
  };
});
vi.mock("./entities", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    useChildThreadInputs: () => [],
    useThreadShell: state.threadShell,
    useProject: () => null,
    useEnvironmentServerConfig: () => null,
    useThreadReportedModelSelection: () => {
      useLayoutEffect(() => {
        state.threadCommit();
      });
      return null;
    },
  };
});
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment" } }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("./device", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const atom = Atom.make(AsyncResult.success(null));
  return { deviceEnvironment: { state: () => atom } };
});
vi.mock("./preview", () => ({ useThreadServerBrowserTabs: () => ({ tabs: [], loaded: true }) }));
vi.mock("./use-composer-drafts", () => ({ getComposerDraftSnapshot: () => ({ text: "" }) }));
vi.mock("./edit-pending-thread-message", () => ({ editPendingThreadMessage: async () => false }));
vi.mock("./threads", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    threadEnvironment: {
      interruptTurn: { label: "interrupt turn", run: vi.fn(async () => AsyncResult.success(undefined)) },
      unsnooze: { label: "unsnooze", run: vi.fn(async () => AsyncResult.success(undefined)) },
      unsettle: { label: "unsettle", run: vi.fn(async () => AsyncResult.success(undefined)) },
      visit: {
        label: "visit thread",
        run: vi.fn(async () => AsyncResult.success(undefined)),
      },
      updateMetadata: {
        label: "update thread metadata",
        run: vi.fn(async () => AsyncResult.success(undefined)),
      },
    },
  };
});
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected" } },
  }),
}));
vi.mock("./use-thread-composer-state", () => ({
  useThreadDraftForThread: () => ({ draftMessage: "" }),
}));
vi.mock("../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({ "--color-icon": "black" }) }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../features/settings/appearance/useAppearanceCodeSurface", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    useAppearanceCodeSurface: () => {
      useLayoutEffect(() => {
        state.reviewCommit();
      });
      return { nativeReviewDiffStyle: { rowHeight: 20 } };
    },
  };
});
vi.mock("../features/layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspacePaneRole: () => {},
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { supportsAuxiliaryPane: false, auxiliaryPaneVisible: false },
    showAuxiliaryPane: () => {},
    toggleAuxiliaryPane: () => {},
  }),
  useRegisterWorkspaceInspector: () => {},
}));
vi.mock("../features/voice-input/VoiceInputProvider", () => ({
  useGlobalVoiceInput: () => ({ session: {} }),
}));
vi.mock("../features/browser/ThreadBrowserFloat", () => ({ ThreadBrowserFloat: () => null }));
vi.mock("../features/threads/ComposerErrorNotice", () => ({ ComposerErrorNotice: () => null }));
vi.mock("../features/threads/ComposerUsageLimits", () => ({ ComposerUsageLimits: () => null }));
vi.mock("../features/threads/PendingUserInputCard", () => ({ PendingUserInputCard: () => null }));
vi.mock("../features/threads/floating-working-control", () => ({
  FLOATING_WORKING_CONTROL_COVERAGE: 0,
  FloatingWorkingControl: () => null,
}));
vi.mock("../features/threads/ThreadComposer", () => ({
  COMPOSER_COLLAPSED_CHROME: 50,
  COMPOSER_EXPANDED_CHROME: 100,
  COMPOSER_LAYOUT_TRANSITION: undefined,
  COMPOSER_TRANSITION_DURATION_MS: 0,
  ThreadComposer: () => null,
}));
vi.mock("../features/threads/ThreadFeed", () => ({ ThreadFeed: () => null }));
vi.mock("../features/threads/ThreadAgentsSheet", () => ({ useThreadTurnSubagents: () => null }));
vi.mock("../features/threads/ComposerQueuedEdit", () => ({ ComposerQueuedEditBanner: () => null }));
vi.mock("../features/threads/ThreadQueueControl", () => ({ useThreadQueuedCount: () => 0 }));
vi.mock("../features/review/useReviewHeaderPresentation", () => ({
  useReviewHeaderPresentation: () => ({ title: "Review changes", gitMenu: null }),
}));
vi.mock("../features/diffs/nativeReviewDiffSurface", () => ({
  resolveNativeReviewDiffView: () => null,
  isNativeReviewDiffDrawEvent: () => false,
}));
vi.mock("../features/review/useReviewSections", () => ({
  useReviewSections: state.reviewSections,
}));
vi.mock("../features/review/useNativeReviewDiffBridge", () => ({
  useNativeReviewDiffBridge: () => ({}),
}));

import { ThreadDetailScreen } from "../features/threads/ThreadDetailScreen";
import type { ThreadDetailScreenProps } from "../features/threads/ThreadDetailScreen";
import { ReviewSheet } from "../features/review/ReviewSheet";
import {
  useVcsActionSupport,
  useVcsTerminology,
  vcsEnvironment,
  VcsTerminologyContext,
} from "./vcs";
import { SubagentRow } from "../features/threads/SubagentRow";
import { useEnvironmentQuery } from "./query";

const environmentId = EnvironmentId.make("environment");
const selectedThread = presentThreadShell(environmentId, v2ThreadShell);
const noop = () => {};
const asyncNoop = async () => {};
const threadProps: ThreadDetailScreenProps = {
  canOperateThread: true,
  selectedThread,
  selectedThreadDetailRef: { environmentId, threadId: selectedThread.id },
  contentPresentation: { kind: "ready" },
  screenTone: { label: "Idle", pillClassName: "", textClassName: "" },
  connectionError: null,
  environmentLabel: "Environment",
  feedbackSubmissions: [],
  onDismissFeedback: noop,
  selectedThreadFeed: [],
  activityRun: null,
  activeWorkStartedAt: null,
  isCompacting: false,
  creationState: null,
  activePendingApproval: null,
  activePendingApprovals: [],
  respondingApprovalId: null,
  activePendingUserInput: null,
  activePendingUserInputDrafts: {},
  activePendingUserInputAnswers: null,
  respondingUserInputId: null,
  connectionStateLabel: "connected",
  activeThreadBusy: false,
  canStopThread: false,
  queuedRunEdit: null,
  composerDraftKey: null,
  followUpBehavior: "queue",
  canSteerActiveTurn: false,
  isSavingQueuedEdit: false,
  onCancelQueuedRunEdit: noop,
  onRemoveQueuedEditAttachment: noop,
  environmentId,
  projectWorkspaceRoot: "/repo",
  threadCwd: "/repo",
  selectedThreadQueueCount: 0,
  queuedMessages: [],
  dispatchingMessageId: null,
  serverConfig: null,
  onOpenConnectionEditor: noop,
  onChangeDraftMessage: noop,
  onPickDraftMedia: asyncNoop,
  onPickDraftFiles: asyncNoop,
  onNativePasteImages: asyncNoop,
  onNativePasteText: asyncNoop,
  onRemoveDraftImage: noop,
  onStopThread: noop,
  onResumeQueue: null,
  onSendMessage: async () => null,
  onReconnectEnvironment: noop,
  canSwitchThreadProvider: false,
  onUpdateThreadModelSelection: noop,
  onUpdateThreadRuntimeMode: noop,
  onUpdateThreadInteractionMode: noop,
  onRespondToApproval: async () => undefined,
  onSelectUserInputOption: noop,
  onChangeUserInputCustomAnswer: noop,
  onSubmitUserInput: asyncNoop,
  onDismissUserInput: asyncNoop,
};
const gitStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

it("does not rerender passive Git hooks on ordinary or waiting local status events", async () => {
  const registry = AtomRegistry.make();
  const statusAtom = Atom.make<AsyncResult.AsyncResult<VcsStatusLocalResult>>(
    AsyncResult.success(gitStatus),
  );
  state.status.mockReset().mockReturnValue(statusAtom);
  let renders = 0;
  let terminology = GIT_VCS_TERMINOLOGY;
  let unsupportedReason: string | null = null;
  function Probe() {
    renders += 1;
    terminology = useVcsTerminology(environmentId, "/repo");
    unsupportedReason = useVcsActionSupport(environmentId, "/repo").unsupportedReason;
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    expect(terminology).toBe(GIT_VCS_TERMINOLOGY);
    expect(unsupportedReason).toBeNull();
    expect(state.status).toHaveBeenCalledTimes(2);
    for (const [target] of state.status.mock.calls) {
      expect(target).toEqual({ environmentId, input: { cwd: "/repo", includeRemote: false } });
    }
    const initialRenders = renders;
    await act(() =>
      registry.set(statusAtom, AsyncResult.success({ ...gitStatus, hasWorkingTreeChanges: true })),
    );
    expect(renders - initialRenders).toBe(0);
    await act(() => registry.set(statusAtom, AsyncResult.waiting(AsyncResult.success(gitStatus))));
    expect(renders - initialRenders).toBe(0);
    await act(() =>
      registry.set(statusAtom, AsyncResult.success({ ...gitStatus, vcs: { kind: "jj" } })),
    );
    expect(renders - initialRenders).toBe(1);
    expect(terminology).toBe(JJ_VCS_TERMINOLOGY);
    await act(() =>
      registry.set(
        statusAtom,
        AsyncResult.success({
          ...gitStatus,
          vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
        }),
      ),
    );
    expect(renders - initialRenders).toBe(2);
    expect(unsupportedReason).toBe("Unsupported workspace");
    await act(() => registry.set(statusAtom, AsyncResult.success(gitStatus)));
    expect(renders - initialRenders).toBe(3);
    expect(terminology).toBe(GIT_VCS_TERMINOLOGY);
    expect(unsupportedReason).toBeNull();
  } finally {
    await act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});

it.each(["ThreadDetailScreen", "ReviewSheet"] as const)(
  "%s shares full status with its sibling without rendering on ordinary or waiting events",
  async (screen) => {
    const registry = AtomRegistry.make();
    const target = { environmentId, input: { cwd: "/repo" } };
    const statusAtom = Atom.make<AsyncResult.AsyncResult<VcsStatusLocalResult>>(
      AsyncResult.success(gitStatus),
    );
    const atoms = new Map([[JSON.stringify(target), statusAtom]]);
    state.status.mockReset().mockImplementation((input) => {
      const key = JSON.stringify(input);
      let atom = atoms.get(key);
      if (!atom) {
        atom = Atom.make<AsyncResult.AsyncResult<VcsStatusLocalResult>>(
          AsyncResult.success(gitStatus),
        );
        atoms.set(key, atom);
      }
      return atom;
    });
    state.reviewSections.mockClear();
    // These layout effects belong to the actual screen's fiber: count its
    // commits, excluding speculative calls and descendant-only updates.
    const renders = screen === "ThreadDetailScreen" ? state.threadCommit : state.reviewCommit;
    renders.mockClear();
    let siblingRenders = 0;
    function FullStatusSibling() {
      siblingRenders += 1;
      useEnvironmentQuery(vcsEnvironment.status(target));
      return null;
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            {screen === "ThreadDetailScreen" ? (
              <ThreadDetailScreen {...threadProps} />
            ) : (
              <ReviewSheet route={{ params: { environmentId, threadId: selectedThread.id } }} />
            )}
            <FullStatusSibling />
          </RegistryContext.Provider>,
        ),
      );
      expect(renders).toHaveBeenCalled();
      expect(siblingRenders).toBeGreaterThan(0);
      expect(atoms.size).toBe(1);
      for (const [input] of state.status.mock.calls) expect(input).toEqual(target);

      const publish = async (
        result: AsyncResult.AsyncResult<VcsStatusLocalResult>,
        expectedRenders: number,
      ) => {
        const before = renders.mock.calls.length;
        const siblingBefore = siblingRenders;
        await act(() => registry.set(statusAtom, result));
        expect(renders.mock.calls.length - before).toBe(expectedRenders);
        expect(siblingRenders - siblingBefore).toBe(1);
        expect(atoms.size).toBe(1);
      };
      const dirtyGitStatus = { ...gitStatus, hasWorkingTreeChanges: true };
      await publish(AsyncResult.success(dirtyGitStatus), 0);
      await publish(AsyncResult.waiting(AsyncResult.success(dirtyGitStatus)), 0);
      const jjStatus: VcsStatusLocalResult = { ...gitStatus, vcs: { kind: "jj" } };
      await publish(AsyncResult.success(jjStatus), 1);
      if (screen === "ReviewSheet") {
        expect(state.reviewSections).toHaveBeenLastCalledWith(
          expect.objectContaining({ vcsKind: "jj", enabled: true }),
        );
      }
      await publish(AsyncResult.success({ ...jjStatus, hasWorkingTreeChanges: true }), 0);
      await publish(AsyncResult.waiting(AsyncResult.success(jjStatus)), 0);
      const unsupportedStatus: VcsStatusLocalResult = {
        ...jjStatus,
        vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
      };
      await publish(AsyncResult.success(unsupportedStatus), 1);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unsupported workspace");
      if (screen === "ReviewSheet") {
        expect(state.reviewSections).toHaveBeenLastCalledWith(
          expect.objectContaining({ vcsKind: "jj", enabled: false }),
        );
      }
      await publish(AsyncResult.waiting(AsyncResult.success(unsupportedStatus)), 0);
      await publish(AsyncResult.success(jjStatus), 1);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await publish(AsyncResult.success(gitStatus), 1);
      if (screen === "ReviewSheet") {
        expect(state.reviewSections).toHaveBeenLastCalledWith(
          expect.objectContaining({ vcsKind: null, enabled: true }),
        );
      }
    } finally {
      await act(() => root.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    }
  },
);

it("uses inherited jj workspace terminology in subagent rows without querying status", async () => {
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  const childThreadId = ThreadId.make("subagent-child");
  state.threadShell.mockImplementation((ref: { threadId: string } | null) =>
    ref
      ? {
          source: {
            ...v2ThreadShell,
            worktreePath: ref.threadId === childThreadId ? "/workspaces/child" : "/repo",
            branch: null,
          },
        }
      : null,
  );
  state.status.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    const row = (
      <SubagentRow
        environmentId={environmentId}
        subagent={{
          threadId: selectedThread.id,
          childThreadId,
          model: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          title: "Child agent",
          prompt: "Inspect the child workspace",
          status: "running",
          result: null,
        }}
        elapsed={null}
      />
    );
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <VcsTerminologyContext value={JJ_VCS_TERMINOLOGY}>{row}</VcsTerminologyContext>
        </RegistryContext.Provider>,
      ),
    );
    expect(container.querySelector('[aria-label="Workspace: child"]')).not.toBeNull();
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <VcsTerminologyContext value={GIT_VCS_TERMINOLOGY}>{row}</VcsTerminologyContext>
        </RegistryContext.Provider>,
      ),
    );
    expect(container.querySelector('[aria-label="Worktree: child"]')).not.toBeNull();
    expect(state.status).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    state.threadShell.mockReset();
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
