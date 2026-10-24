import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import {
  createOutdatedServerDescriptionCommand,
  createOutdatedServerUpdateCommand,
} from "@t3tools/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";
import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
});
export const describeOutdatedServer = createOutdatedServerDescriptionCommand(connectionAtomRuntime);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const threadListEnvironmentsAtom = createThreadListEnvironmentsAtom(
  environmentServerConfigsAtom,
);

const worktreeMergeConfiguredFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((projectId: ProjectId) =>
    Atom.make((get) => {
      const settings = get(serverEnvironment.configValueAtom(environmentId))?.settings;
      return (
        settings !== undefined &&
        resolveProjectSettings(settings, projectId).settings.worktreeCommands.merge !== ""
      );
    }),
  ),
);

/** Whether the project has a worktree merge command. A boolean, so a list row re-renders only when the answer changes. */
export const worktreeMergeConfiguredAtom = (environmentId: EnvironmentId, projectId: ProjectId) =>
  worktreeMergeConfiguredFamily(environmentId)(projectId);
