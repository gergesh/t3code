import type { VcsStatusResult } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native header item factories are only read when options are applied, so the fake
// navigation snapshots the right items at each setOptions, as native-stack does.
const harness = vi.hoisted(() => ({
  setOptionsCalls: 0,
  renderedRightItems: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  navigatedRoutes: [] as string[],
  openedPullRequests: [] as string[],
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.setOptionsCalls += 1;
      harness.renderedRightItems.push(options.unstable_headerRightItems?.() ?? []);
    },
  };
  return {
    NavigationRouteContext: createContext(null),
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
  };
});
vi.mock("../../components/ui/Toolbar", () => ({
  Toolbar: Object.assign(() => null, {
    Button: () => null,
    Menu: () => null,
    MenuAction: () => null,
    Label: () => null,
  }),
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => () => {},
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedPullRequests.push(url);
    return true;
  },
}));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../components/ui/AppBar", async () => {
  const { NativeStackScreenOptions } = await import("../../native/StackHeader");
  return {
    AppBar: (props: import("../../components/ui/AppBar.types").AppBarProps) => (
      <NativeStackScreenOptions options={props.options} optionsVersion={props.optionsVersion} />
    ),
  };
});
vi.mock("react-native", () => ({ Alert: { alert: () => {} }, Linking: {}, Platform: {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { ThreadHeader } from "./ThreadHeader";

const projectScripts: never[] = [];

function status(
  files: ReadonlyArray<string>,
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "master",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as unknown as VcsStatusResult;
}

function Header(props: { readonly gitStatus: VcsStatusResult | null; readonly title?: string }) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      headerColor="#000"
      usesNativeHeaderGlass
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitStatus: props.gitStatus,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      hasWorkspaceRoot
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenGitInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

function renderedGitMenuItems(): Array<{
  description?: unknown;
  label?: unknown;
  onPress?: () => void;
}> {
  const items = harness.renderedRightItems.at(-1) ?? [];
  const git = items.find((item) => item.identifier === "thread-right-git") as
    | { menu: { items: Array<{ description?: unknown; label?: unknown; onPress?: () => void }> } }
    | undefined;
  return git?.menu.items ?? [];
}

function renderedGitStatusDescription(): unknown {
  return renderedGitMenuItems()[0]?.description;
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.setOptionsCalls = 0;
  harness.renderedRightItems = [];
  harness.navigatedRoutes = [];
  harness.openedPullRequests = [];
});

describe("ThreadHeader", () => {
  it("opens the existing PR from the clean synced Git quick action", async () => {
    const url = "https://example.com/pr/1";
    render(
      <Header
        gitStatus={status([], {
          hasPrimaryRemote: true,
          hasUpstream: true,
          pr: { state: "open", url },
        } as Partial<VcsStatusResult>)}
      />,
    );
    expect(renderedGitMenuItems()[1]?.label).toBe("View PR");
    await act(async () => renderedGitMenuItems()[1]?.onPress?.());
    expect(harness.openedPullRequests).toEqual([url]);
    expect(harness.navigatedRoutes).toEqual([]);
  });
});
