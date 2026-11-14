import { useAtomValue } from "@effect/atom-react";
import type { AgentRole, EnvironmentId, ProjectsListAgentRolesResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { useFilesystemReadAccess } from "./filesystem";
import { projectEnvironment } from "./projects";

const EMPTY_ROLES: ReadonlyArray<AgentRole> = [];
const EMPTY_AGENT_ROLES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectsListAgentRolesResult, never>(false),
).pipe(Atom.withLabel("agent-roles-query:empty"));

/** The `.agents/roles` roles in a checkout; empty while loading, on error, or without file access. */
export function useAgentRoles(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): ReadonlyArray<AgentRole> {
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const atom =
    environmentId !== null && cwd !== null && cwd.length > 0 && canReadFiles
      ? projectEnvironment.listAgentRoles({ environmentId, input: { cwd } })
      : EMPTY_AGENT_ROLES_QUERY_ATOM;
  const result = useAtomValue(atom);
  return AsyncResult.getOrElse(result, () => null)?.roles ?? EMPTY_ROLES;
}
