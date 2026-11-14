import type { ScopedThreadRef } from "@t3tools/contracts";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE } from "../../types";

export type OrchestratorModeTarget =
  | { readonly kind: "server"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "draft"; readonly draftTarget: ComposerThreadTarget };

/** A started thread changes mode now; a draft keeps the mode until it creates its thread. */
export function useSetOrchestratorMode() {
  const setThreadInteractionMode = useOrchestrationCommand(
    threadEnvironment.setInteractionMode,
    "change orchestrator mode",
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  return async (target: OrchestratorModeTarget, enabled: boolean) => {
    const interactionMode = enabled ? "orchestrate" : DEFAULT_INTERACTION_MODE;
    if (target.kind === "draft") {
      setDraftThreadContext(target.draftTarget, { interactionMode });
      return;
    }
    await setThreadInteractionMode({
      environmentId: target.threadRef.environmentId,
      input: {
        threadId: target.threadRef.threadId,
        interactionMode,
        createdAt: new Date().toISOString(),
      },
    });
  };
}
