import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

import {
  AGENT_ROLES_DIRECTORY,
  type AgentRole,
  type AgentRoleName,
  type AgentRoleProblem,
  isAgentRoleName,
  RuntimeMode,
} from "@t3tools/contracts";

const FRONTMATTER_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MAX_ROLE_FILE_BYTES = 64 * 1024;
const isRuntimeMode = Schema.is(RuntimeMode);

export type AgentRoleCatalog = {
  readonly roles: ReadonlyArray<AgentRole>;
  readonly problems: ReadonlyArray<AgentRoleProblem>;
};

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Parses one role file. Unknown frontmatter keys are ignored so other tools' fields can coexist. */
export function parseAgentRoleFile(
  fileName: string,
  text: string,
): { readonly role: AgentRole } | { readonly problem: string } {
  const stem = fileName.replace(/\.md$/, "");
  if (!isAgentRoleName(stem)) {
    return {
      problem: "The file name must be lowercase letters, digits, '-' and '_', ending in .md.",
    };
  }
  const match = FRONTMATTER_PATTERN.exec(text);
  let fields: Record<string, unknown> = {};
  if (match !== null) {
    let parsed: unknown;
    try {
      parsed = parseYamlDocument(match[1] ?? "");
    } catch (cause) {
      return { problem: `The frontmatter is not valid YAML: ${String(cause)}` };
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return { problem: "The frontmatter must be a YAML mapping." };
      }
      fields = parsed as Record<string, unknown>;
    }
  }
  const name = stringField(fields.name);
  if (name !== undefined && name !== stem) {
    return { problem: `\`name: ${name}\` must match the file name, ${stem}.` };
  }
  const runtimeMode = stringField(fields.runtime_mode ?? fields.runtimeMode);
  if (runtimeMode !== undefined && !isRuntimeMode(runtimeMode)) {
    return {
      problem: `\`runtime_mode: ${runtimeMode}\` must be one of ${RuntimeMode.literals.join(", ")}.`,
    };
  }
  let allow: Array<AgentRoleName> | undefined;
  if (fields.allow !== undefined && fields.allow !== null) {
    const entries = Array.isArray(fields.allow) ? fields.allow : [fields.allow];
    const invalid = entries.filter(
      (entry) => typeof entry !== "string" || !isAgentRoleName(entry.replace(/^@/, "")),
    );
    if (invalid.length > 0) {
      return { problem: `\`allow\` has entries that are not role names: ${invalid.join(", ")}.` };
    }
    allow = entries.map((entry) => String(entry).replace(/^@/, "") as AgentRoleName);
  }
  const names = (key: "skills" | "tools") => {
    const value = fields[key];
    if (value === undefined || value === null) return { names: undefined };
    const entries = Array.isArray(value) ? value : [value];
    const invalid = entries.filter((entry) => typeof entry !== "string" || entry.trim() === "");
    return invalid.length > 0
      ? { problem: `\`${key}\` must be a list of names.` }
      : { names: entries.map((entry) => String(entry).trim()) };
  };
  const skills = names("skills");
  if ("problem" in skills) return { problem: skills.problem };
  const tools = names("tools");
  if ("problem" in tools) return { problem: tools.problem };
  const description = stringField(fields.description);
  const provider = stringField(fields.provider);
  const model = stringField(fields.model);
  return {
    role: {
      name: stem,
      title: stringField(fields.title) ?? stem,
      ...(description === undefined ? {} : { description }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
      ...(allow === undefined ? {} : { allow }),
      ...(skills.names === undefined ? {} : { skills: skills.names }),
      ...(tools.names === undefined ? {} : { tools: tools.names }),
      instructions: (match === null ? text : text.slice(match[0].length)).trim(),
    },
  };
}

/** Whether a role's `tools` list (names, or `prefix*`) lets its agent see a T3 Code tool. */
export const roleToolAllowed = (patterns: ReadonlyArray<string> | undefined, tool: string) =>
  patterns === undefined ||
  patterns.some((pattern) =>
    pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool,
  );

/** Whether a thread in `from` may delegate to `to`. A thread without a role may use any. */
export const roleMayDelegateTo = (from: AgentRole | undefined, to: AgentRoleName): boolean =>
  from?.allow === undefined || from.allow.includes(to);

/** Finds a requested role and checks that the caller's own role may hand work to it. */
export function resolveRequestedRole(input: {
  readonly roles: ReadonlyArray<AgentRole>;
  readonly callerRole: string | null | undefined;
  readonly requested: string;
}): { readonly role: AgentRole } | { readonly problem: string } {
  const name = input.requested.replace(/^@/, "");
  const role = input.roles.find((candidate) => candidate.name === name);
  if (role === undefined) {
    return {
      problem:
        input.roles.length === 0
          ? `This project defines no roles in ${AGENT_ROLES_DIRECTORY}, so role "${name}" does not exist.`
          : `Role "${name}" is not defined in ${AGENT_ROLES_DIRECTORY}. Roles: ${input.roles.map((candidate) => candidate.name).join(", ")}.`,
    };
  }
  const own = input.roles.find((candidate) => candidate.name === input.callerRole);
  if (!roleMayDelegateTo(own, role.name)) {
    return {
      problem: own?.allow?.length
        ? `@${own.name} may hand work only to ${own.allow.map((allowed) => `@${allowed}`).join(", ")}, not @${role.name}.`
        : `@${own?.name} may not hand work to other roles.`,
    };
  }
  return { role };
}

/** The standing brief a thread in this role receives once per native conversation. */
export function agentRoleBrief(input: {
  readonly name: string;
  readonly role: AgentRole | undefined;
}): string {
  const file = `${AGENT_ROLES_DIRECTORY}/${input.name}.md`;
  const role = input.role;
  if (role === undefined) {
    return `## Your role: @${input.name}

This thread acts as @${input.name}, but \`${file}\` is missing or invalid in this checkout, so there is no brief. Tell the user if the role matters for the request.`;
  }
  const reach =
    role.allow === undefined
      ? "To hand work to another role, call `delegate_task` with its `role`; `orchestrator_capabilities` lists them."
      : role.allow.length === 0
        ? "Do not delegate to other roles."
        : `To hand work to another role, call \`delegate_task\` with its \`role\`. You may delegate to ${role.allow.map((name) => `@${name}`).join(", ")}.`;
  const heading = role.title === role.name ? `@${role.name}` : `@${role.name} (${role.title})`;
  return `## Your role: ${heading}

This thread acts as @${role.name}, defined in \`${file}\`. Follow this brief for the whole conversation, under the user's direct requests. ${reach}

${role.instructions}`;
}

export const AGENT_ROLE_ENDED_NOTE = `## Your role has ended

The user took this thread's role away. The earlier role brief no longer applies.`;

/** A short, stable digest of a brief, so an edited role file is sent again. */
export function agentRoleBriefDigest(brief: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < brief.length; index += 1) {
    hash ^= brief.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class AgentRoles extends Context.Service<
  AgentRoles,
  {
    /** Never fails: a missing folder has no roles, and unreadable or invalid files are problems. */
    readonly list: (cwd: string) => Effect.Effect<AgentRoleCatalog>;
    readonly get: (cwd: string, name: string) => Effect.Effect<AgentRole | undefined>;
  }
>()("t3/project/AgentRoles") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readRole = Effect.fn("AgentRoles.readRole")(function* (directory: string, file: string) {
    const filePath = path.join(directory, file);
    const info = yield* fileSystem.stat(filePath);
    if (info.type !== "File") return { problem: "Not a file." } as const;
    if (Number(info.size) > MAX_ROLE_FILE_BYTES) {
      return { problem: `Larger than ${MAX_ROLE_FILE_BYTES / 1024} KB.` } as const;
    }
    return parseAgentRoleFile(file, yield* fileSystem.readFileString(filePath));
  });

  const list: AgentRoles["Service"]["list"] = Effect.fn("AgentRoles.list")(function* (cwd) {
    const directory = path.join(cwd, AGENT_ROLES_DIRECTORY);
    const files = yield* fileSystem.readDirectory(directory).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.endsWith(".md")).toSorted()),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    const roles: Array<AgentRole> = [];
    const problems: Array<AgentRoleProblem> = [];
    for (const file of files) {
      const result = yield* readRole(directory, file).pipe(
        Effect.catch((cause) => Effect.succeed({ problem: `Unreadable: ${cause.message}` })),
      );
      if ("role" in result) roles.push(result.role);
      else problems.push({ file: `${AGENT_ROLES_DIRECTORY}/${file}`, message: result.problem });
    }
    for (const role of roles) {
      const unknown = (role.allow ?? []).filter(
        (name) => !roles.some((candidate) => candidate.name === name),
      );
      if (unknown.length > 0) {
        problems.push({
          file: `${AGENT_ROLES_DIRECTORY}/${role.name}.md`,
          message: `\`allow\` names roles that do not exist: ${unknown.join(", ")}.`,
        });
      }
    }
    return { roles, problems };
  });

  const get: AgentRoles["Service"]["get"] = Effect.fn("AgentRoles.get")(function* (cwd, name) {
    if (!isAgentRoleName(name)) return undefined;
    const result = yield* readRole(path.join(cwd, AGENT_ROLES_DIRECTORY), `${name}.md`).pipe(
      Effect.orElseSucceed(() => ({ problem: "Unreadable." })),
    );
    return "role" in result ? result.role : undefined;
  });

  return AgentRoles.of({ list, get });
});

export const layer = Layer.effect(AgentRoles, make);
