import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  status: vi.fn(),
  listRefs: vi.fn(),
  toolbarRenders: 0,
  pickerRenders: 0,
  serverThread: true,
  branch: "main" as string | null,
  draft: false,
  refsError: null as string | null,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status, listRefs: state.listRefs }),
  createVcsActionManager: () => ({}),
}));
vi.mock("../composerDraftStore", async () => {
  // Mock factories are hoisted before this test module's static imports.
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: (select: (store: unknown) => unknown) =>
      select({
        getDraftSession: () =>
          state.draft ? { environmentId: "local", projectId: "project", worktreePath: null } : null,
        getDraftThreadByRef: () =>
          state.draft ? { environmentId: "local", projectId: "project", worktreePath: null } : null,
        setDraftThreadContext: vi.fn(),
      }),
  };
});
vi.mock("../state/entities", () => ({
  useServerConfigs: () => new Map(),
  useQuietThreadShell: () => {
    return state.serverThread
      ? {
          id: "thread",
          environmentId: "local",
          projectId: "project",
          branch: state.branch,
          worktreePath: null,
          runtime: {},
        }
      : null;
  },
  useProject: () => ({ workspaceRoot: "/repo" }),
  useThreadShellsForProjectRefs: () => {
    // Observe only commits of the target body, not speculative renders or child commits.
    useLayoutEffect(() => {
      state.toolbarRenders += 1;
    });
    return [];
  },
}));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: () => {
    useLayoutEffect(() => {
      state.pickerRenders += 1;
    });
    return {
      refs: [],
      data: null,
      error: state.refsError,
      isPending: false,
      isFetchingNextPage: false,
      loadNext: vi.fn(),
    };
  },
}));
vi.mock("../localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("./BranchToolbarEnvironmentSelector", () => ({
  BranchToolbarEnvironmentSelector: () => null,
}));
vi.mock("./BranchToolbarEnvModeSelector", () => ({ BranchToolbarEnvModeSelector: () => null }));
vi.mock("./ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: { add: vi.fn() } }));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./AddProjectToMachineDialog", () => ({ openAddProjectToMachine: vi.fn() }));
vi.mock("../hooks/useAddProjectTargets", () => ({ useAddProjectTargets: () => [] }));
vi.mock("../state/threads", () => ({
  threadEnvironment: { stopSession: vi.fn(), updateMetadata: vi.fn() },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("./ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  resolveThreadPullRequestBadge: () => null,
  prStatusIndicator: () => null,
  ThreadPullRequestBadgeControl: () => null,
}));
vi.mock("./chat/ThreadDetailsPrRows", () => ({ ThreadDetailsPrRows: () => null }));

import { BranchToolbar } from "./BranchToolbar";
import { WorktreeBaseBranchPicker } from "./WorktreeBaseBranchPicker";

const environmentId = EnvironmentId.make("local");
const gitStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const toolbarProps = {
  environmentId,
  threadId: ThreadId.make("thread"),
  showGitControls: true,
  envMode: "local",
  envLocked: false,
  startFromOrigin: false,
  onStartFromOriginChange: vi.fn(),
  onEnvModeChange: vi.fn(),
  projectId: ProjectId.make("project"),
  worktreePath: null,
  get isServerThread() {
    return state.serverThread;
  },
} satisfies ComponentProps<typeof BranchToolbar>;

function makeHarness() {
  state.serverThread = true;
  state.branch = "main";
  state.draft = false;
  state.toolbarRenders = 0;
  state.pickerRenders = 0;
  state.refsError = null;
  const registry = AtomRegistry.make();
  const source = Atom.make<AsyncResult.AsyncResult<VcsStatusResult>>(
    AsyncResult.success(gitStatus),
  );
  const startedKeys = new Set<string>();
  const statuses = Atom.family((key: string) =>
    Atom.make((get) => {
      startedKeys.add(key);
      return get(source);
    }),
  );
  state.status.mockReset().mockImplementation((target) => statuses(JSON.stringify(target)));
  state.listRefs
    .mockReset()
    .mockReturnValue(
      Atom.make(AsyncResult.success({ refs: [], isRepo: true, hasPrimaryRemote: false })),
    );
  return {
    registry,
    source,
    startedKeys,
    wrap: (children: ReactNode) => (
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it.each(["toolbar", "picker"] as const)(
  "mounts the real %s without rendering on ordinary or waiting status events",
  async (component) => {
    using h = makeHarness();
    await using screen = await render(
      h.wrap(
        <>
          {component === "toolbar" ? (
            <BranchToolbar {...toolbarProps} />
          ) : (
            <WorktreeBaseBranchPicker
              environmentId={environmentId}
              cwd="/repo"
              value="main"
              onValueChange={vi.fn()}
              startFromOrigin={false}
              onStartFromOriginChange={vi.fn()}
            />
          )}
        </>,
      ),
      { router: false },
    );
    const renders = () => (component === "toolbar" ? state.toolbarRenders : state.pickerRenders);
    const initial = renders();
    expect(initial).toBeGreaterThan(0);
    if (component === "picker") {
      expect(screen.container.querySelector("button")?.disabled).toBe(false);
    }
    expect([...h.startedKeys]).toEqual(
      component === "toolbar" ? [JSON.stringify({ environmentId, input: { cwd: "/repo" } })] : [],
    );
    await act(() =>
      h.registry.set(h.source, AsyncResult.success({ ...gitStatus, hasWorkingTreeChanges: true })),
    );
    expect(renders()).toBe(initial);
    await act(() => h.registry.set(h.source, AsyncResult.waiting(AsyncResult.success(gitStatus))));
    expect(renders()).toBe(initial);
    await act(() =>
      h.registry.set(h.source, AsyncResult.success({ ...gitStatus, vcs: { kind: "jj" } })),
    );
    expect(renders()).toBe(initial + (component === "toolbar" ? 1 : 0));
    await act(() =>
      h.registry.set(
        h.source,
        AsyncResult.success({
          ...gitStatus,
          vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
        }),
      ),
    );
    expect(renders()).toBe(initial + (component === "toolbar" ? 2 : 0));
    await act(() => h.registry.set(h.source, AsyncResult.success(gitStatus)));
    expect(renders()).toBe(initial + (component === "toolbar" ? 3 : 0));
  },
);

it.each(["Temporary refs failure", "This Jujutsu repository cannot be read."])(
  "preserves main's enabled picker and selected-ref lookup on refs error: %s",
  async (error) => {
    using h = makeHarness();
    state.refsError = error;
    await using screen = await render(
      h.wrap(
        <WorktreeBaseBranchPicker
          environmentId={environmentId}
          cwd="/repo"
          value="main"
          onValueChange={vi.fn()}
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
        />,
      ),
      { router: false },
    );
    expect(screen.container.querySelector("button")?.disabled).toBe(false);
    await act(() => screen.container.querySelector("button")?.click());
    expect(document.body.textContent).toContain(state.refsError);
    expect(state.listRefs).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", query: "main", limit: 10 },
    });
    expect([...h.startedKeys]).toEqual([]);
  },
);

it.each(["draft", "branchless", "sidebar-hidden"] as const)(
  "holds only main's full-status key with %s",
  async (scenario) => {
    using h = makeHarness();
    state.serverThread = scenario !== "draft";
    state.draft = scenario === "draft";
    state.branch = scenario === "branchless" ? null : "main";
    // No Sidebar is mounted: every case must work without its local-status consumer.
    // The branchless case supplies an actual null thread branch through the entity hook.
    await using screen = await render(h.wrap(<BranchToolbar {...toolbarProps} />), {
      router: false,
    });
    expect([...h.startedKeys]).toEqual([
      JSON.stringify({ environmentId, input: { cwd: "/repo" } }),
    ]);
    const initial = state.toolbarRenders;
    await act(() =>
      h.registry.set(
        h.source,
        AsyncResult.success({
          ...gitStatus,
          vcs: { kind: "jj" },
        }),
      ),
    );
    expect(state.toolbarRenders).toBe(initial + 1);
    expect([...h.startedKeys]).toEqual([
      JSON.stringify({ environmentId, input: { cwd: "/repo" } }),
    ]);
  },
);

it("does not subscribe without Git controls, but keeps workspace-only panels protected", async () => {
  using h = makeHarness();
  await using screen = await render(
    h.wrap(<BranchToolbar {...toolbarProps} showGitControls={false} />),
    { router: false },
  );
  expect([...h.startedKeys]).toEqual([]);
  await screen.rerender(
    h.wrap(<BranchToolbar {...toolbarProps} layout="panel" panelSection="workspace" />),
  );
  expect([...h.startedKeys]).toEqual([JSON.stringify({ environmentId, input: { cwd: "/repo" } })]);
  const initial = state.toolbarRenders;
  await act(() =>
    h.registry.set(
      h.source,
      AsyncResult.success({
        ...gitStatus,
        vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
      }),
    ),
  );
  expect(state.toolbarRenders).toBe(initial + 1);
});
