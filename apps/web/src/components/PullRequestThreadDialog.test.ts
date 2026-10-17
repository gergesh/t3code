import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  GitCommandError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canOperate: false,
  canWriteSourceControl: true,
  vcsStatus: ((): { vcs: { kind: "git"; unsupportedReason: string } } | null => null)(),
  hookValues: [] as unknown[],
  hookIndex: 0,
  tracks: 0,
  resets: 0,
  manager: { operation: null as string | null, error: null, isRunning: false },
  interrupted: false,
  preparationError: null as unknown,
  pendingResponse: undefined as Promise<void> | undefined,
  openChanges: [] as boolean[],
  checkouts: [] as string[],
  setupScripts: 0,
  prepared: [] as { branch: string; worktreePath: string | null }[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const index = state.hookIndex++;
    if (index === state.hookValues.length) state.hookValues.push(initial);
    return [state.hookValues[index], (value: unknown) => (state.hookValues[index] = value)];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("@tanstack/react-pacer", () => ({
  useDebouncedValue: (value: unknown) => [value, { state: { isPending: false } }],
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === AuthOrchestrationOperateScope
      ? state.canOperate
      : scope === AuthSourceControlWriteScope && state.canWriteSourceControl,
  readEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === AuthOrchestrationOperateScope
      ? state.canOperate
      : scope === AuthSourceControlWriteScope && state.canWriteSourceControl,
}));
vi.mock("~/state/sourceControlActions", async () => {
  const { usePreparePullRequestThreadAction } = await vi.importActual<
    typeof import("~/state/sourceControlActions")
  >("~/state/sourceControlActions");
  return {
    readCachedPullRequestResolution: () => null,
    usePullRequestResolutionState: () => ({
      data: { pullRequest: { number: 123, title: "Pull request", state: "open" } },
    }),
    usePreparePullRequestThreadAction,
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.manager }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("~/state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("~/state/git", () => ({
  gitEnvironment: {
    preparePullRequestThread: async ({
      input: { mode, threadId },
    }: {
      input: { mode: string; threadId?: string };
    }) => {
      state.checkouts.push(mode);
      if (mode === "worktree" && threadId) state.setupScripts += 1;
      await state.pendingResponse;
      if (state.interrupted) return AsyncResult.failure(Cause.interrupt());
      if (state.preparationError) return AsyncResult.failure(Cause.fail(state.preparationError));
      return AsyncResult.success({
        branch: "feature/pr",
        worktreePath: mode === "worktree" ? "/worktree" : null,
        isOnPullRequestHead: true,
      });
    },
  },
}));
vi.mock("~/lib/utils", () => ({ cn: () => "" }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: state.vcsStatus }) }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => null },
  vcsActionManager: {
    stateAtom: () => "vcs-state",
    track: (_registry: unknown, _target: unknown, _input: unknown, execute: () => unknown) => {
      state.tracks += 1;
      return execute();
    },
    resetError: () => state.resets++,
  },
}));
vi.mock("./ui/button", () => ({ Button: "Button" }));
vi.mock("./ui/input", () => ({ Input: "Input" }));
vi.mock("./ui/spinner", () => ({ Spinner: "Spinner" }));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./ui/dialog", () => ({
  Dialog: "Dialog",
  DialogDescription: "DialogDescription",
  DialogFooter: "DialogFooter",
  DialogHeader: "DialogHeader",
  DialogPanel: "DialogPanel",
  DialogPopup: "DialogPopup",
  DialogTitle: "DialogTitle",
}));

import { PullRequestThreadDialog } from "./PullRequestThreadDialog";

function findAction(node: ReactNode, label: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label);
      if (action) return action;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => unknown }>(node)) return null;
  if (node.props.children === label) return node.props.onClick ?? null;
  return findAction(node.props.children, label);
}

function renderDialog() {
  state.hookIndex = 0;
  return PullRequestThreadDialog({
    open: true,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    cwd: "/repo",
    initialReference: "123",
    onOpenChange: (open) => state.openChanges.push(open),
    onPrepared: (input) => {
      state.prepared.push(input);
    },
  });
}

function prepareAction(label: "Local" | "Worktree") {
  const action = findAction(renderDialog(), label);
  if (!action) throw new Error(`${label} action missing`);
  return action;
}

describe("pull request worktree permissions", () => {
  beforeEach(() => {
    state.vcsStatus = null;
    state.canOperate = false;
    state.canWriteSourceControl = true;
    state.hookValues = [];
    state.hookIndex = 0;
    state.tracks = 0;
    state.resets = 0;
    state.manager = { operation: null, error: null, isRunning: false };
    state.interrupted = false;
    state.preparationError = null;
    state.pendingResponse = undefined;
    state.openChanges = [];
    state.checkouts = [];
    state.setupScripts = 0;
    state.prepared = [];
  });

  it("rechecks task permission before invoking a retained worktree action", async () => {
    state.canOperate = true;
    const prepare = prepareAction("Worktree");
    state.canOperate = false;
    await prepare();

    expect(state.checkouts).toEqual([]);
    expect(state.setupScripts).toBe(0);
  });
  it.each(["Local", "Worktree"] as const)(
    "refuses direct %s preparation when the checkout is unsupported",
    async (label) => {
      state.canOperate = true;
      state.vcsStatus = { vcs: { kind: "git", unsupportedReason: "Checkout is unavailable." } };
      await prepareAction(label)();
      expect(visibleText(renderDialog())).toContain("Checkout is unavailable.");
      expect(state.checkouts).toEqual([]);
      expect(state.setupScripts).toBe(0);
      expect(state.prepared).toEqual([]);
    },
  );

  it.each(["unsupported_repository", "path_already_exists"] as const)(
    "shows the serialized %s workspace preparation error",
    async (reason) => {
      state.canOperate = true;
      const codec = Schema.toCodecJson(GitCommandError);
      const error = new GitCommandError({
        operation: "preparePullRequestThread",
        command: "jj",
        cwd: "/repo",
        reason,
        detail: "Enable colocation with jj git colocation enable.",
      });
      state.preparationError = Schema.decodeSync(codec)(Schema.encodeSync(codec)(error));

      await prepareAction("Worktree")();

      expect(visibleText(renderDialog())).toContain(
        reason === "unsupported_repository" ? error.detail : error.message,
      );
      expect(state.prepared).toEqual([]);
      expect(state.openChanges).toEqual([]);
    },
  );
});

function visibleText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<{ children?: ReactNode }>(node) ? visibleText(node.props.children) : "";
}
