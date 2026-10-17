import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { Mock } from "vite-plus/test";

import "~/index.css";
import { act, render as renderUi } from "../../test/render";

interface HarnessState {
  worktreePath: string | null;
  unsupportedReason: string | null;
  pickerProps: {
    open: boolean;
    onQueryChange: (query: string) => void;
    onSelectItem: (value: string) => void;
    onLoadNext: () => void;
  } | null;
  branchCwd: string | null;
  diffHeader: ReactNode;
  showContextMenu: Mock;
  writeTextToClipboard: Mock;
  command: Mock;
  loadNext: Mock;
  refresh: Mock;
  previewQuery: Mock;
}

const state = vi.hoisted((): HarnessState => ({
  worktreePath: "/tmp/worktree",
  unsupportedReason: null,
  pickerProps: null,
  branchCwd: null,
  diffHeader: null,
  showContextMenu: vi.fn(),
  writeTextToClipboard: vi.fn(),
  command: vi.fn(),
  loadNext: vi.fn(),
  refresh: vi.fn(),
  previewQuery: vi.fn(),
}));

vi.mock(import("../localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readLocalApi: () => {
      const api = actual.readLocalApi();
      return api
        ? { ...api, contextMenu: { ...api.contextMenu, show: state.showContextMenu } }
        : undefined;
    },
  };
});
vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock(import("./BranchPicker"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    BranchPicker: (props: ComponentProps<typeof actual.BranchPicker>) => {
      state.pickerProps = props;
      return <actual.BranchPicker {...props} />;
    },
  };
});
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data:
      query === null || query === "diff-preview"
        ? null
        : {
            vcs: { kind: "git", unsupportedReason: state.unsupportedReason },
            isRepo: true,
            refName: "main",
            refs: [],
          },
    isPending: false,
    refresh: state.refresh,
  }),
  useEnvironmentQuerySelector: (_query: unknown, select: (result: unknown) => unknown) =>
    select(
      AsyncResult.success({
        vcs: { kind: "git", unsupportedReason: state.unsupportedReason },
        isRepo: true,
        refName: "main",
        refs: [],
      }),
    ),
}));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: ({ cwd }: { cwd: string | null }) => {
    state.branchCwd = cwd;
    return {
      refs: [{ name: "feature", isRemote: false, current: false, isDefault: false }],
      data: { nextCursor: "next", totalCount: 2 },
      isPending: false,
      isFetchingNextPage: false,
      refresh: state.refresh,
      loadNext: state.loadNext,
    };
  },
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("./AddProjectToMachineDialog", () => ({ openAddProjectToMachine: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => state.command,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  resolveThreadPullRequestBadge: () => null,
  prStatusIndicator: () => null,
  ThreadPullRequestBadgeControl: () => null,
}));
vi.mock("./chat/ThreadDetailsPrRows", () => ({
  ThreadDetailsPrRows: () => null,
}));
vi.mock("../lib/openPullRequestLink", () => ({
  useOpenPrLink: () => vi.fn(),
}));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: state.previewQuery,
    diffFileContents: vi.fn(),
    diffFilePatch: vi.fn(),
  },
}));
vi.mock("../hooks/useThreadRouteTarget", () => ({
  useThreadRouteTarget: () => ({
    kind: "server",
    threadRef: {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("thread"),
    },
  }),
  useThreadRouteRef: () => ({
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("thread"),
  }),
}));
vi.mock("../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../state/entities", () => ({
  useServerConfigs: () => new Map(),
  useQuietThreadShell: () => ({
    id: "thread",
    branch: "main",
    environmentId: "local",
    projectId: "project",
    worktreePath: state.worktreePath,
  }),
  useProject: () => ({ workspaceRoot: "/tmp/project" }),
  useThreadShellsForProjectRefs: () => [],
  useThreadCheckpointSummaries: () => [],
}));
vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: () => null,
}));
vi.mock("./DiffPanelShell", () => ({
  DiffPanelShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => {
    state.diffHeader = header;
    return (
      <div>
        {header}
        {children}
      </div>
    );
  },
  DiffPanelLoadingState: () => null,
  DiffFileHeaderSkeleton: () => null,
}));

import { BranchToolbar } from "./BranchToolbar";
import DiffPanel from "./DiffPanel";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { DropdownMenuRadioGroup } from "./ui/menu";

function findScopeChange(node: ReactNode): ((value: string) => void) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findScopeChange(child);
      if (found) return found;
    }
    return null;
  }
  if (
    !isValidElement<{
      children?: ReactNode;
      onValueChange?: (value: string) => void;
    }>(node)
  )
    return null;
  if (node.type === DropdownMenuRadioGroup) return node.props.onValueChange ?? null;
  return findScopeChange(node.props.children);
}

function resetHarness() {
  state.worktreePath = "/tmp/worktree";
  state.unsupportedReason = null;
  state.pickerProps = null;
  state.command.mockReset();
  state.loadNext.mockReset();
  state.refresh.mockReset();
  state.diffHeader = null;
  state.previewQuery.mockReset().mockReturnValue("diff-preview");
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
}

function setupHarness(): Disposable {
  resetHarness();
  return { [Symbol.dispose]: resetHarness };
}

function toolbarUi(props: Partial<ComponentProps<typeof BranchToolbar>>) {
  return (
    <BranchToolbar
      layout="panel"
      panelSection="workspace"
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      projectId={ProjectId.make("project")}
      worktreePath={state.worktreePath}
      isServerThread
      showGitControls
      envMode="local"
      envLocked={false}
      startFromOrigin={false}
      onStartFromOriginChange={vi.fn()}
      onEnvModeChange={vi.fn()}
      {...props}
    />
  );
}

function render(
  props: Partial<ComponentProps<typeof BranchToolbar>>,
  { worktreePath = "/tmp/worktree" }: { worktreePath?: string | null } = {},
) {
  state.worktreePath = worktreePath;
  return renderUi(toolbarUi(props));
}

it("closes an already-open branch picker and refuses direct actions after support is lost", async () => {
  using _harness = setupHarness();
  const onCheckoutPullRequestRequest = vi.fn();
  const worktreePath = null;
  const props: Partial<ComponentProps<typeof BranchToolbar>> = {
    panelSection: "branch",
    onCheckoutPullRequestRequest,
  };
  await using screen = await render(props, { worktreePath });
  await userEvent.click(page.getByRole("combobox"));
  expect(state.pickerProps?.open).toBe(true);
  await act(async () => state.pickerProps!.onQueryChange("123"));
  const openPicker = state.pickerProps!;
  state.loadNext.mockClear();
  state.refresh.mockClear();

  state.unsupportedReason = "Checkout is unavailable.";
  await screen.rerender(toolbarUi(props));
  expect(state.pickerProps?.open).toBe(false);
  await expect.element(page.getByRole("combobox")).toBeDisabled();
  expect(state.branchCwd).toBeNull();
  await act(async () => {
    openPicker.onSelectItem("feature");
    openPicker.onSelectItem("__create_new_branch__:123");
    openPicker.onSelectItem("__checkout_pull_request__:123");
    openPicker.onLoadNext();
  });
  expect(state.command).not.toHaveBeenCalled();
  expect(state.loadNext).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(onCheckoutPullRequestRequest).not.toHaveBeenCalled();
});

it("refuses retained scope dispatch when an already-open Changes panel becomes unsupported", async () => {
  using _harness = setupHarness();
  const threadRef = {
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("thread"),
  };
  await using screen = await renderUi(
    <DiffPanel composerDraftTarget={threadRef} workspaceMutationId={null} visible />,
  );
  await expect
    .element(page.getByRole("button", { name: "Diff scope: Changes", exact: true }))
    .toBeVisible();
  const selectScope = findScopeChange(state.diffHeader);
  if (!selectScope) throw new Error("Changes scope handler was not rendered.");
  expect(state.previewQuery).toHaveBeenCalled();

  state.unsupportedReason = "Checkout is unavailable.";
  state.previewQuery.mockClear();
  await screen.rerender(
    <DiffPanel composerDraftTarget={threadRef} workspaceMutationId={null} visible />,
  );
  await expect.element(page.getByRole("alert")).toHaveTextContent("Checkout is unavailable.");
  expect(state.previewQuery).not.toHaveBeenCalled();
  await act(async () => selectScope("unstaged"));
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toEqual({ kind: "branch", baseRef: null });
  expect(state.command).not.toHaveBeenCalled();
});
