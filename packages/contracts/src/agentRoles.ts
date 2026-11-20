import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/** Roles are the markdown files in this folder of a project's checkout, one role per file. */
export const AGENT_ROLES_DIRECTORY = ".agents/roles";

const AGENT_ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** A role's file name without `.md`: lowercase letters, digits, `-` and `_`. */
export const AgentRoleName = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) =>
    AGENT_ROLE_NAME_PATTERN.test(value)
      ? true
      : "A role name is lowercase letters, digits, '-' and '_', at most 48 characters.",
  ),
);
export type AgentRoleName = typeof AgentRoleName.Type;

export const isAgentRoleName = (value: string): value is AgentRoleName =>
  AGENT_ROLE_NAME_PATTERN.test(value);

export const AgentRole = Schema.Struct({
  name: AgentRoleName,
  /** Shown beside the name; the file's `title`, else the name. */
  title: Schema.String,
  description: Schema.optional(Schema.String),
  /** Provider instance id or driver kind a thread in this role starts on. */
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Roles this role may delegate to. Absent allows every role; empty allows none. */
  allow: Schema.optional(Schema.Array(AgentRoleName)),
  /** Skills the agent sees. Absent shows every skill; empty shows none. */
  skills: Schema.optional(Schema.Array(Schema.String)),
  /** T3 Code tools the agent sees, by name or `prefix*`. Absent shows every tool. */
  tools: Schema.optional(Schema.Array(Schema.String)),
  /** The file's body: the standing brief the agent receives. */
  instructions: Schema.String,
});
export type AgentRole = typeof AgentRole.Type;

export const AgentRoleProblem = Schema.Struct({
  file: Schema.String,
  message: Schema.String,
});
export type AgentRoleProblem = typeof AgentRoleProblem.Type;

export const ProjectsListAgentRolesInput = Schema.Struct({
  /** The project root, or a thread's worktree, whose roles to read. */
  cwd: TrimmedNonEmptyString,
});
export type ProjectsListAgentRolesInput = typeof ProjectsListAgentRolesInput.Type;

export const ProjectsListAgentRolesResult = Schema.Struct({
  roles: Schema.Array(AgentRole),
  problems: Schema.Array(AgentRoleProblem),
});
export type ProjectsListAgentRolesResult = typeof ProjectsListAgentRolesResult.Type;
