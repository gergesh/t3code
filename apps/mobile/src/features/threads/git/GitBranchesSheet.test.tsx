import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  value: string;
  onChangeText: (value: string) => void;
};
type ActionProps = { label: string; disabled: boolean; onPress: () => void };
type VcsState = { kind: "git" | "jj"; unsupportedReason?: string };
type BranchState = {
  name: string;
  current: boolean;
  isDefault: boolean;
  worktreePath: string | null;
};
const state = vi.hoisted(() => ({
  refName: null as string | null,
  branch: null as string | null,
  vcs: null as VcsState | null,
  branches: [] as BranchState[],
  title: null as string | null,
  inputs: new Map<string, InputProps>(),
  actions: new Map<string, ActionProps>(),
  worktrees: [] as Array<{ baseBranch: string; newBranch: string }>,
  focused: true,
  goBackCalls: 0,
  gitResult: Promise.resolve<object | null>(null),
  mutations: 0,
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({
    goBack: () => state.goBackCalls++,
    isFocused: () => state.focused,
  }),
}));
vi.mock("../../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../../components/ui/SheetHeader", () => ({
  SheetHeader: (props: { title: string }) => {
    state.title = props.title;
    return null;
  },
}));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <>
      {header}
      {children}
    </>
  ),
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/FormSection", () => ({
  FormSection: ({ children }: { children: ReactNode }) => children,
  FormField: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../components/ui/ListSection", () => ({
  ListSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: ActionProps) => {
    state.actions.set(props.label, props);
    return null;
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data:
      state.refName === null && state.vcs === null
        ? undefined
        : { refName: state.refName, vcs: state.vcs },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment", branch: state.branch },
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: state.branches,
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: true,
    onCreateSelectedThreadBranch: () => {
      state.mutations++;
      return state.gitResult;
    },
    onCheckoutSelectedThreadBranch: () => {
      state.mutations++;
      return state.gitResult;
    },
    onCreateSelectedThreadWorktree: (input: { baseBranch: string; newBranch: string }) => {
      state.worktrees.push(input);
      return state.gitResult;
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("./gitSheetComponents", () => ({
  SheetActionButton: (props: ActionProps) => {
    state.actions.set(props.label, props);
    return null;
  },
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

function setup(
  options: {
    readonly branch?: string | null;
    readonly vcs?: VcsState | null;
    readonly branches?: BranchState[];
  } = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.refName = null;
  state.branch = options.branch ?? null;
  state.vcs = options.vcs ?? null;
  state.branches = options.branches ?? [
    { name: "release/stable", current: false, isDefault: false, worktreePath: null },
  ];
  state.title = null;
  state.inputs.clear();
  state.actions.clear();
  state.worktrees = [];
  state.gitResult = Promise.resolve(null);
  state.focused = true;
  state.goBackCalls = 0;
  state.mutations = 0;
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(() => {
      root.render(
        <GitBranchesSheet
          route={{ params: { environmentId: "environment", threadId: "thread" } }}
        />,
      );
    });
  render();
  return {
    render,
    press(label: string) {
      act(() => state.actions.get(label)!.onPress());
    },
    edit(label: string, value: string) {
      act(() => state.inputs.get(label)!.onChangeText(value));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it.each([null, "stale-branch"])(
  "uses the loaded checkout branch when thread metadata is %s",
  (branch) => {
    using screen = setup({ branch });
    screen.edit("Worktree branch name", "feature/new-worktree");
    state.refName = "release/stable";
    screen.render();
    screen.press("Create worktree");
    expect(state.worktrees).toEqual([
      { baseBranch: "release/stable", newBranch: "feature/new-worktree" },
    ]);
  },
);

it.each(["custom-base", ""])("preserves an edited base %j when status arrives", (base) => {
  using screen = setup();
  screen.edit("Worktree base branch", base);
  screen.edit("Worktree branch name", "feature/new-worktree");
  state.refName = "release/stable";
  screen.render();
  expect(state.inputs.get("Worktree base branch")!.value).toBe(base);
  expect(state.actions.get("Create worktree")!.disabled).toBe(base === "");
  screen.press("Create worktree");
  expect(state.worktrees).toEqual(
    base === "" ? [] : [{ baseBranch: base, newBranch: "feature/new-worktree" }],
  );
});

it.each(["Create worktree", "Create & checkout", "release/stable"])(
  "does not navigate back when %s finishes after the sheet lost focus",
  async (action) => {
    using screen = setup();
    const gitResult = Promise.withResolvers<object>();
    state.gitResult = gitResult.promise;
    screen.edit("New branch name", "feature/new-branch");
    screen.edit("Worktree branch name", "feature/new-worktree");
    screen.press(action);
    state.focused = false;

    await act(async () => {
      gitResult.resolve({ refName: "feature/ready" });
      await gitResult.promise;
    });
    expect(state.goBackCalls).toBe(0);
  },
);

it("disables and refuses unsupported repository actions without navigation", async () => {
  using screen = setup({
    vcs: { kind: "jj", unsupportedReason: "Install Jujutsu" },
    branches: [{ name: "main", current: false, isDefault: true, worktreePath: null }],
  });
  screen.edit("New bookmark name", "feature/bookmark");
  screen.edit("Workspace base bookmark", "main");
  screen.edit("Workspace bookmark name", "feature/workspace");
  for (const action of [
    state.actions.get("Create & switch")!,
    state.actions.get("Create workspace")!,
    state.actions.get("main")!,
  ]) {
    expect(action.disabled).toBe(true);
    await act(async () => action.onPress());
  }
  expect(state.mutations).toBe(0);
  expect(state.worktrees).toEqual([]);
  expect(state.goBackCalls).toBe(0);
});

it.each([
  ["git", "Branches & worktrees"],
  ["jj", "Bookmarks & workspaces"],
] as const)("titles the %s sheet in its own terms", (kind, title) => {
  using _screen = setup({ vcs: { kind } });
  expect(state.title).toBe(title);
});
