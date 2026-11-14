import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: vi.fn((input: unknown) => input),
  query: vi.fn(),
  fullQuery: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsActionManager: () => ({}),
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsStatusRevalidationAtomFamily: () => () => null,
}));
vi.mock("./query", () => ({
  useEnvironmentQuerySelector: state.query,
  useEnvironmentQuery: state.fullQuery,
}));

import { chatGitStatusAtom, useVcsTerminology } from "./vcs";

const status = (changes: Partial<VcsStatusResult> = {}) =>
  AsyncResult.success({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 1, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...changes,
  } satisfies VcsStatusResult);

const jjStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  pr: null,
  vcs: { kind: "jj" },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.fullQuery.mockReturnValue({ data: jjStatus });
  state.query.mockImplementation(
    (
      _atom: unknown,
      select: (result: AsyncResult.AsyncResult<VcsStatusResult, unknown>) => unknown,
    ) => select(AsyncResult.success(jjStatus)),
  );
});

describe("chatGitStatusAtom", () => {
  it("notifies only when a field the chat view reads changes", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<AsyncResult.AsyncResult<VcsStatusResult, never>>(status());
    const selected = chatGitStatusAtom(source as never);
    const notified: unknown[] = [];
    const unsubscribe = registry.subscribe(selected, (value) => notified.push(value));
    registry.get(selected);
    notified.length = 0;

    registry.set(
      source,
      status({ workingTree: { files: [], insertions: 2, deletions: 0 }, aheadCount: 1 }),
    );
    expect(notified).toEqual([]);

    registry.set(source, status({ refName: "feature" }));
    expect(notified).toHaveLength(1);

    registry.set(source, status({ refName: "feature", hasWorkingTreeChanges: false }));
    expect(notified).toHaveLength(2);

    const pr = () => ({
      number: 42,
      title: "Feature PR",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature",
      state: "open" as const,
    });
    const linked = { refName: "feature", hasWorkingTreeChanges: false };
    registry.set(source, status({ ...linked, pr: pr() }));
    expect(notified).toHaveLength(3);

    // A new object with the same data, as each remote status refresh sends.
    registry.set(source, status({ ...linked, pr: pr() }));
    expect(notified).toHaveLength(3);
    unsubscribe();
  });
});

describe("passive VCS terminology", () => {
  it("reads local status through a stable terminology selector", () => {
    const environmentId = EnvironmentId.make("environment");
    expect(useVcsTerminology(environmentId, "/repo")).toBe(JJ_VCS_TERMINOLOGY);
    expect(state.query).toHaveBeenCalledOnce();
    expect(state.fullQuery).not.toHaveBeenCalled();
    expect(state.status).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", includeRemote: false },
    });
    const selector = state.query.mock.calls[0]?.[1];
    useVcsTerminology(environmentId, "/repo");
    expect(state.query.mock.calls[1]?.[1]).toBe(selector);
    expect(selector(AsyncResult.success({ ...jjStatus, aheadCount: 3 }))).toBe(JJ_VCS_TERMINOLOGY);
    expect(selector(AsyncResult.initial())).toBe(GIT_VCS_TERMINOLOGY);
  });

  it.each([
    [null, "/repo"],
    [EnvironmentId.make("environment"), null],
  ])("does not request status for an incomplete target", (environmentId, cwd) => {
    useVcsTerminology(environmentId, cwd);
    expect(state.status).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenCalledWith(null, expect.any(Function));
  });
});
