import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ComposerDraft, ComposerDraftSettingsUpdate } from "../../state/use-composer-drafts";
import type { QueuedThreadMessage } from "../../state/thread-outbox";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { buildHomeProjectScopes, type HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  isSameRepository,
  newTaskDestination,
  newTaskFilteredProject,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";

const flowState = vi.hoisted(() => {
  // Assigned once the imports are live; the mocks only read it when a test runs.
  const registry = null as unknown as import("effect/reactivity").AtomRegistry.AtomRegistry;
  const draft: ComposerDraft = { text: "Keep chatting", attachments: [] };
  return {
    registry,
    draft,
    status: {
      branchName: "main",
      vcs: { kind: "jj", unsupportedReason: "This workspace is unsupported" },
    },
    model: { instanceId: "codex", model: "gpt-5" },
  };
});

vi.mock("../../state/olderSettledShelf", () => ({ useOlderSettledCount: () => 0 }));
vi.mock("../triage/usePrepareTriage", () => ({ usePrepareTriage: () => async () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [makeProject("project")],
  useThreadShells: () => [],
  useEnvironmentServerConfig: () => ({
    providers: [],
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
  }),
  useServerConfigs: () => new Map(),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
  serverConfigForCwd: (config: unknown) => config,
  resolveDefaultableModelSelection: () => null,
  resolveNewTaskModelSelection: () => flowState.model,
  resolveSelectableModelSelection: () => flowState.model,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "status"
        ? AsyncResult.success(flowState.status)
        : flowState.registry.get(atom as never),
    set: (atom: unknown, value: unknown) => flowState.registry.set(atom as never, value as never),
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: vi.fn(), openScratch: vi.fn() },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => ({
    data: target === "status" ? flowState.status : null,
    error: null,
    isPending: false,
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  createNewTaskDraft: () => "new-task:test",
  useComposerDraft: () => flowState.draft,
  getComposerDraftSnapshot: () => flowState.draft,
  updateComposerDraftSettings: (_key: string, settings: ComposerDraftSettingsUpdate) => {
    flowState.draft = { ...flowState.draft, ...settings };
  },
  useStickyComposerModelSelection: () => null,
  composerDraftsLoadedAtom: Atom.make(true),
  retargetNewTaskDraft: vi.fn(),
  setComposerDraftText: vi.fn(),
  isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
  clearComposerDraft: vi.fn(),
  appendComposerDraftAttachments: vi.fn(),
  removeComposerDraftAttachment: vi.fn(),
  replaceComposerDraftAttachments: vi.fn(),
  setStickyComposerModelSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
  scheduleUnusedComposerAttachmentCleanup: vi.fn(),
  isComposerDraftEmpty: (draft: ComposerDraft) =>
    draft.text === "" && draft.attachments.length === 0,
}));
vi.mock("../../state/queries", () => ({
  useBranches: () => ({ data: { isRepo: true }, isPending: false }),
  useDebouncedValue: (value: string) => value,
  usePaginatedBranches: () => ({
    refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    data: { nextCursor: null },
    isPending: false,
    isFetchingNextPage: false,
    refresh: vi.fn(),
    loadNext: vi.fn(),
  }),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => "status" } }));
vi.mock("../../state/use-worktree-repository-choices", () => ({
  useWorktreeRepositoryChoices: () => ({ choices: [], tracksGitRepositories: false }),
}));
vi.mock("../../state/thread-outbox", () => ({
  flattenQueuedThreadMessages: () => [],
  threadOutboxManager: {},
}));
vi.mock("../../state/use-thread-outbox", () => ({
  useThreadOutboxMessages: () => ({}),
  holdEditingQueuedMessage: vi.fn(),
  releaseEditingQueuedMessage: vi.fn(),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "repository" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));

vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-model-option-memory", () => ({
  rememberModelOptions: vi.fn(),
  withRememberedModelOptions: (value: unknown) => value,
}));
vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => new Map() }));
vi.mock("../../state/project-has-threads", () => ({ useProjectHasThreads: () => false }));
vi.mock("../../state/workspace", () => ({
  useConnectionsReady: () => true,
  useWorkspaceEnvironments: () => [],
}));
vi.mock("../../state/shell", () => ({ useEnvironmentShellReadiness: () => ({}) }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));

import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";
import { updateNewTaskFlowState } from "./new-task-flow-state";

flowState.registry = AtomRegistry.make();

describe("unsupported new-task workspace recovery", () => {
  it.each(["saved", "default"])(
    "can leave an unsupported %s worktree choice and build a local chat task",
    async (source) => {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
      flowState.draft = {
        text: "Keep chatting",
        attachments: [],
        ...(source === "saved"
          ? { workspaceSelection: { mode: "worktree", branch: "main", worktreePath: null } }
          : {}),
      };
      // Picking the project binds the flow to its draft (see setProject).
      updateNewTaskFlowState("test-flow", { draftKey: "new-task:test" });
      const container = document.createElement("div");
      const root = createRoot(container);
      const metadata = {
        threadId: "thread",
        commandId: "command",
        messageId: "message",
        createdAt: "2026-07-01T00:00:00.000Z",
      };
      function CaptureFlow() {
        const flow = useNewTaskFlow();
        const [message, setMessage] = useState<QueuedThreadMessage | null>(null);
        return createElement(
          "div",
          null,
          createElement("output", { "data-mode": true }, flow.workspaceMode),
          createElement("output", { "data-supported": true }, String(flow.vcsActionsSupported)),
          createElement(
            "button",
            { "data-local": true, onClick: () => flow.setWorkspaceMode("local") },
            "Use local",
          ),
          createElement(
            "button",
            { "data-worktree": true, onClick: () => flow.setWorkspaceMode("worktree") },
            "Use worktree",
          ),
          createElement(
            "button",
            {
              "data-create": true,
              onClick: () => setMessage(flow.buildPendingTaskMessage(metadata)),
            },
            "Create task",
          ),
          createElement("output", { "data-message": true }, message?.text ?? "blocked"),
          createElement("output", { "data-created-mode": true }, message?.creation?.workspaceMode),
        );
      }
      try {
        await act(async () =>
          root.render(
            createElement(
              RegistryContext.Provider,
              { value: flowState.registry },
              createElement(
                NewTaskFlowProvider,
                { active: true, flowKey: "test-flow" },
                createElement(CaptureFlow),
              ),
            ),
          ),
        );
        expect(container.querySelector("[data-mode]")?.textContent).toBe("worktree");
        expect(container.querySelector("[data-supported]")?.textContent).toBe("false");
        await act(async () => container.querySelector<HTMLButtonElement>("[data-create]")!.click());
        expect(container.querySelector("[data-message]")?.textContent).toBe("blocked");
        await act(async () => {
          container.querySelector<HTMLButtonElement>("[data-local]")!.click();
          root.render(
            createElement(
              RegistryContext.Provider,
              { value: flowState.registry },
              createElement(
                NewTaskFlowProvider,
                { active: true, flowKey: "test-flow" },
                createElement(CaptureFlow),
              ),
            ),
          );
        });
        expect(container.querySelector("[data-mode]")?.textContent).toBe("local");
        await act(async () => container.querySelector<HTMLButtonElement>("[data-create]")!.click());
        expect(container.querySelector("[data-message]")?.textContent).toBe("Keep chatting");
        expect(container.querySelector("[data-created-mode]")?.textContent).toBe("local");
        await act(async () => {
          container.querySelector<HTMLButtonElement>("[data-worktree]")!.click();
          root.render(
            createElement(
              RegistryContext.Provider,
              { value: flowState.registry },
              createElement(
                NewTaskFlowProvider,
                { active: true, flowKey: "test-flow" },
                createElement(CaptureFlow),
              ),
            ),
          );
        });
        expect(container.querySelector("[data-mode]")?.textContent).toBe("local");
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/t3code",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    pinned: false,
    archived: false,
  };
}

describe("getProjectScopeSelectionTarget", () => {
  it("chooses an open copy of a repository over an archived copy on the preferred machine", () => {
    const repo = { repositoryKey: "github.com/t3tools/t3code" };
    const archived = {
      ...makeProject("archived-copy", "mac", repo),
      archivedAt: "2026-07-02T00:00:00.000Z",
    };
    const open = makeProject("open-copy", "server", repo);
    const [scope] = buildHomeProjectScopes({
      projects: [archived, open],
      environmentId: null,
      projectGroupingMode: "repository",
    });
    if (!scope || scope.archived) throw new Error("Expected a pickable repository group");

    expect(
      getProjectScopeSelectionTarget(
        scope,
        archived.environmentId,
        new Set([archived.environmentId, open.environmentId]),
      ).id,
    ).toBe(open.id);
  });

  it("prefers a connected copy of a project that spans environments", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const target = (connected: ReadonlyArray<string>, preferred: string | null = null) =>
      getProjectScopeSelectionTarget(
        makeScope([mac, server]),
        preferred === null ? null : EnvironmentId.make(preferred),
        new Set(connected.map((id) => EnvironmentId.make(id))),
      );
    expect(target(["server"])).toBe(server);
    expect(target(["server"], "mac")).toBe(server);
    expect(target(["mac", "server"], "server")).toBe(server);
    expect(target(["mac", "server"])).toBe(mac);
    // With nothing connected, the usual order still applies.
    expect(target([], "server")).toBe(server);
    expect(target([])).toBe(mac);
  });

  it("starts in the repository root over an earlier sub-folder in the same environment", () => {
    const identity = (project: EnvironmentProject) => ({
      ...project.repositoryIdentity!,
      rootPath: "/work/workspace",
    });
    const base = makeProject("old-tool", "mac", {
      workspaceRoot: "/work/workspace/_archive/old-tool",
      repositoryKey: "github.com/owner/workspace",
    });
    const subfolder = { ...base, repositoryIdentity: identity(base) };
    const root = {
      ...makeProject("workspace", "mac", { workspaceRoot: "/work/workspace" }),
      repositoryIdentity: identity(base),
    };
    expect(
      getProjectScopeSelectionTarget(
        { ...makeScope([subfolder, root]), representative: root },
        EnvironmentId.make("mac"),
        new Set([EnvironmentId.make("mac")]),
      ),
    ).toBe(root);
  });
});

describe("newTaskFilteredProject", () => {
  type Last = { readonly environmentId: string; readonly projectId: string };
  const mac = makeProject("t3code", "mac");
  const server = makeProject("t3code", "server");
  const docs = makeProject("docs", "mac");
  const connected = new Set([mac.environmentId, server.environmentId]);
  const filtered = (input: {
    readonly projectScope?: HomeProjectScope;
    readonly environmentId?: string;
    readonly last?: Last;
  }) =>
    newTaskFilteredProject({
      projectScope: input.projectScope ?? null,
      environmentId:
        input.environmentId === undefined ? null : EnvironmentId.make(input.environmentId),
      scopes: [makeScope([mac, server]), makeScope([docs])],
      connectedEnvironmentIds: connected,
      lastProject: input.last,
    });

  it("never starts in an archived copy of the filtered project", () => {
    const archived = { ...mac, archivedAt: "2026-01-01T00:00:00.000Z" };
    expect(
      filtered({
        projectScope: makeScope([archived, server]),
        last: { environmentId: "mac", projectId: "t3code" },
      }),
    ).toEqual({ environmentId: "server", projectId: "t3code" });
  });

  it("prefers the remembered copy of the filtered project", () => {
    const projectScope = makeScope([mac, server]);
    expect(
      filtered({ projectScope, last: { environmentId: "server", projectId: "t3code" } }),
    ).toEqual({ environmentId: "server", projectId: "t3code" });
    expect(
      filtered({ projectScope, last: { environmentId: "server", projectId: "other" } }),
    ).toEqual({ environmentId: "mac", projectId: "t3code" });
  });

  it("starts in the filtered environment's copy of the remembered project", () => {
    const last = { environmentId: "mac", projectId: "t3code" };
    expect(filtered({ last })).toBeUndefined();
    expect(filtered({ environmentId: "mac", last })).toEqual(last);
    expect(filtered({ environmentId: "server", last })).toEqual({
      environmentId: "server",
      projectId: "t3code",
    });
  });

  it("finds nothing when the remembered project is not on the filtered environment", () => {
    expect(
      filtered({ environmentId: "server", last: { environmentId: "mac", projectId: "docs" } }),
    ).toBeNull();
    expect(filtered({ environmentId: "server" })).toBeNull();
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
    expect(isSameRepository(target[1]!, selected)).toBe(true);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);
    expect(isSameRepository(byBasename[1]!, selected)).toBe(false);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
    expect(isSameRepository(fork, selected)).toBe(false);
  });
});

describe("resolveDraftProjectSelection", () => {
  const projects = [makeProject("t3code"), makeProject("t3code-2")];
  const draft = { incomingShareId: undefined, pickerClosed: false };

  it("opens the picker instead of auto-selecting the only project", () => {
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)], draft)).toEqual({
      kind: "pick",
    });
  });

  it("selects the only logical project for shared content", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        incomingShareId: "share",
      }),
    ).toEqual({ kind: "select", project: projects[0] });
  });

  it("dismisses the draft when the first picker closes without a choice", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("keeps the draft when the picker closes after a choice", () => {
    expect(
      resolveDraftProjectSelection("environment:t3code-2", projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "preserve" });
  });

  it("keeps a share draft asking for a project when its picker closes without a choice", () => {
    const scopes = [makeScope([projects[0]!]), makeScope([projects[1]!])];
    expect(
      resolveDraftProjectSelection(null, projects, scopes, {
        incomingShareId: "share",
        pickerClosed: true,
      }),
    ).toEqual({ kind: "pick" });
  });

  it("starts a share draft in the last project when Use last project is on", () => {
    const scopes = [makeScope([projects[0]!]), makeScope([projects[1]!])];
    const shareDraft = {
      incomingShareId: "share",
      pickerClosed: false,
      useLastProject: undefined,
      lastProject: { environmentId: "environment", projectId: "t3code-2" },
    };
    expect(resolveDraftProjectSelection(null, projects, scopes, shareDraft)).toEqual({
      kind: "select",
      project: projects[1],
    });
    expect(
      resolveDraftProjectSelection(null, projects, scopes, {
        ...shareDraft,
        useLastProject: false,
      }),
    ).toEqual({ kind: "pick" });
    const archived = [projects[0]!, { ...projects[1]!, archivedAt: "2026-07-02T00:00:00.000Z" }];
    expect(resolveDraftProjectSelection(null, archived, scopes, shareDraft)).toEqual({
      kind: "pick",
    });
  });
});

describe("newTaskDestination", () => {
  const picker = { draft: { requestId: "request" } };

  function destination(options: {
    readonly useLastProject: boolean | undefined;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly current?: EnvironmentProject;
    readonly filtered?: EnvironmentProject | null;
    readonly last?: { readonly environmentId: string; readonly projectId: string };
  }) {
    return newTaskDestination({
      projects: options.projects,
      requestId: "request",
      useLastProject: options.useLastProject,
      currentProject: options.current && {
        environmentId: options.current.environmentId,
        projectId: options.current.id,
      },
      filteredProject: options.filtered && {
        environmentId: options.filtered.environmentId,
        projectId: options.filtered.id,
      },
      lastProject: options.last,
    });
  }

  it("starts in the current thread's project ahead of the filtered and remembered ones", () => {
    const projects = [makeProject("remembered"), makeProject("current", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        current: projects[1],
        filtered: projects[0],
        last: { environmentId: "environment", projectId: "remembered" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });

  it("starts in the thread list's filtered project ahead of the remembered one", () => {
    const projects = [makeProject("bravo"), makeProject("alpha")];
    expect(
      destination({
        useLastProject: true,
        projects,
        filtered: projects[1],
        last: { environmentId: "environment", projectId: "bravo" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "alpha" },
    });
  });

  it("opens the picker instead of a remembered project outside the thread list's filters", () => {
    const projects = [makeProject("remembered")];
    expect(
      destination({
        useLastProject: true,
        projects,
        filtered: null,
        last: { environmentId: "environment", projectId: "remembered" },
      }),
    ).toEqual(picker);
  });

  it("opens the picker for an archived last project, but keeps an archived current one", () => {
    const archived = { ...makeProject("archived"), archivedAt: "2026-01-01T00:00:00.000Z" };
    expect(
      destination({
        useLastProject: true,
        projects: [archived],
        last: { environmentId: "environment", projectId: "archived" },
      }),
    ).toEqual(picker);
    expect(destination({ useLastProject: true, projects: [archived], current: archived })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "archived" },
    });
  });

  it("treats an unset preference as on", () => {
    const projects = [makeProject("first"), makeProject("current")];
    expect(destination({ useLastProject: undefined, projects, current: projects[1] })).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });

  it("starts in the remembered project of its own environment when there is no current one", () => {
    const projects = [makeProject("chosen"), makeProject("chosen", "other-environment")];
    expect(
      destination({
        useLastProject: true,
        projects,
        last: { environmentId: "other-environment", projectId: "chosen" },
      }),
    ).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "chosen" },
    });
  });

  it("ignores a remembered project id from another environment", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("chosen")],
        last: { environmentId: "removed-environment", projectId: "chosen" },
      }),
    ).toEqual(picker);
  });

  it("opens the picker rather than the first project when nothing matches", () => {
    expect(
      destination({
        useLastProject: true,
        projects: [makeProject("first"), makeProject("second")],
        current: makeProject("removed"),
      }),
    ).toEqual(picker);
  });

  it("always opens the picker when the preference is off", () => {
    const only = makeProject("only");
    expect(
      destination({
        useLastProject: false,
        projects: [only],
        current: only,
        filtered: only,
        last: { environmentId: "environment", projectId: "only" },
      }),
    ).toEqual(picker);
  });
});

describe("resolveNewTaskScratchOption", () => {
  const environmentId = EnvironmentId.make("environment");
  const otherId = EnvironmentId.make("other");
  const configs = new Map([[environmentId, { scratchWorkspaceRoot: "/scratch" }]]);

  it("offers the option from the cached config while the environment is still connecting", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connecting" }],
        serverConfigs: configs,
        selectedEnvironmentId: null,
      }),
    ).toEqual({ environmentId, ready: false });
  });

  it("becomes ready without changing environment once connected", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: configs,
        selectedEnvironmentId: null,
      }),
    ).toEqual({ environmentId, ready: true });
  });

  it("hides the option when no environment reports a scratch root", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: new Map([[environmentId, {}]]),
        selectedEnvironmentId: null,
      }),
    ).toBeNull();
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: new Map(),
        selectedEnvironmentId: null,
      }),
    ).toBeNull();
  });

  it("prefers a connected environment over the selected one that is still reconnecting", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [
          { environmentId, connectionState: "reconnecting" },
          { environmentId: otherId, connectionState: "connected" },
        ],
        serverConfigs: new Map([
          [environmentId, { scratchWorkspaceRoot: "/scratch" }],
          [otherId, { scratchWorkspaceRoot: "/other-scratch" }],
        ]),
        selectedEnvironmentId: environmentId,
      }),
    ).toEqual({ environmentId: otherId, ready: true });
  });

  it("keeps the selected environment when every offering environment is connected", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [
          { environmentId: otherId, connectionState: "connected" },
          { environmentId, connectionState: "connected" },
        ],
        serverConfigs: new Map([
          [environmentId, { scratchWorkspaceRoot: "/scratch" }],
          [otherId, { scratchWorkspaceRoot: "/other-scratch" }],
        ]),
        selectedEnvironmentId: environmentId,
      }),
    ).toEqual({ environmentId, ready: true });
  });
});
