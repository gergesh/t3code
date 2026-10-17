import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsActionManager: () => ({}),
}));

import { useVcsTerminology } from "./vcs";

const gitStatus: VcsStatusResult = {
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
};

it("only renders when local status terminology changes", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const statusAtom = Atom.make(AsyncResult.success(gitStatus));
  state.status.mockReset().mockReturnValue(statusAtom);
  const environmentId = EnvironmentId.make("environment");
  const captured = { terminology: GIT_VCS_TERMINOLOGY };
  const Probe = vi.fn(function Probe() {
    const terminology = useVcsTerminology(environmentId, "/repo");
    useLayoutEffect(() => {
      captured.terminology = terminology;
    });
    return null;
  });
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
    { router: false },
  );
  const initialRenders = Probe.mock.calls.length;
  expect(captured.terminology).toBe(GIT_VCS_TERMINOLOGY);
  expect(state.status).toHaveBeenCalledOnce();
  for (const [target] of state.status.mock.calls) {
    expect(target).toEqual({ environmentId, input: { cwd: "/repo", includeRemote: false } });
  }
  await act(() =>
    registry.set(
      statusAtom,
      AsyncResult.success({ ...gitStatus, aheadCount: 3, hasWorkingTreeChanges: true }),
    ),
  );
  expect(Probe).toHaveBeenCalledTimes(initialRenders);
  await act(() => registry.set(statusAtom, AsyncResult.waiting(AsyncResult.success(gitStatus))));
  expect(Probe).toHaveBeenCalledTimes(initialRenders);
  await act(() =>
    registry.set(statusAtom, AsyncResult.success({ ...gitStatus, vcs: { kind: "jj" } })),
  );
  expect(Probe).toHaveBeenCalledTimes(initialRenders + 1);
  expect(captured.terminology).toBe(JJ_VCS_TERMINOLOGY);
  await act(() =>
    registry.set(
      statusAtom,
      AsyncResult.success({
        ...gitStatus,
        vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
      }),
    ),
  );
  expect(Probe).toHaveBeenCalledTimes(initialRenders + 1);
  await act(() => registry.set(statusAtom, AsyncResult.success(gitStatus)));
  expect(Probe).toHaveBeenCalledTimes(initialRenders + 2);
  expect(captured.terminology).toBe(GIT_VCS_TERMINOLOGY);
});
