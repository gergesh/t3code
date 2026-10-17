import { createContext } from "react";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  createVcsStatusRevalidationAtomFamily,
} from "@t3tools/client-runtime/state/vcs";
import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  resolveVcsTerminology,
  supportsVcsActions,
  type VcsTerminology,
} from "@t3tools/shared/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeDocumentReturn } from "../lib/documentActivity";
import { useEnvironmentQuerySelector } from "./query";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/** Only what a chat view reads, so changing file counts don't re-render it on every edit. */
export const chatGitStatusAtom = Atom.family((status: ReturnType<typeof vcsEnvironment.status>) =>
  Atom.map(status, (result) => {
    const data = AsyncResult.getOrElse(result, () => null);
    if (data === null) return null;
    const { isRepo, refName, hasWorkingTreeChanges, pr, vcs } = data;
    return { isRepo, refName, hasWorkingTreeChanges, pr, vcs };
  }).pipe(Atom.withEquality(Equal.equals)),
);
export const NO_CHAT_GIT_STATUS_ATOM: ReturnType<typeof chatGitStatusAtom> = Atom.make(null);

/**
 * Refreshes a checkout's status when the user comes back to the window, where
 * edits made in another app or terminal may be waiting.
 */
export const vcsStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});

export const vcsBranchRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshBranch,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});

export const VcsTerminologyContext = createContext(resolveVcsTerminology(null));

export const selectVcsTerminology = (status: AsyncResult.AsyncResult<VcsStatusResult, unknown>) =>
  resolveVcsTerminology(Option.getOrNull(AsyncResult.value(status)));
export const selectVcsActionsSupported = (
  status: AsyncResult.AsyncResult<VcsStatusResult, unknown>,
) => supportsVcsActions(Option.getOrNull(AsyncResult.value(status)));

/** Reads the shared status atom for (environment, cwd); Git terms until it answers. */
export function useVcsTerminology(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): VcsTerminology {
  return useEnvironmentQuerySelector(
    environmentId === null || cwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
    selectVcsTerminology,
  );
}
