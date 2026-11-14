import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AgentRoles from "./AgentRoles.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(AgentRoles.layer),
  Layer.provideMerge(NodeServices.layer),
);

const checkoutWithRoles = Effect.fn("checkoutWithRoles")(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agent-roles-" });
  const directory = path.join(cwd, ".agents", "roles");
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    yield* fileSystem.writeFileString(path.join(directory, name), text);
  }
  return cwd;
});

describe("parseAgentRoleFile", () => {
  it.each([
    ["Engineer.md", "body", "file name must be lowercase"],
    ["qa.md", "---\nname: tester\n---\nbody", "must match the file name"],
    ["qa.md", "---\nruntime_mode: autopilot\n---\nbody", "runtime_mode: autopilot"],
    ["qa.md", "---\nallow: [Not A Role]\n---\nbody", "not role names"],
    ["qa.md", "---\n- a\n- b\n---\nbody", "must be a YAML mapping"],
    ["qa.md", "---\ntools: [3, '']\n---\nbody", "`tools` must be a list of names"],
  ])("rejects %s with %j", (file, text, problem) => {
    const result = AgentRoles.parseAgentRoleFile(file, text);
    expect("problem" in result && result.problem).toContain(problem);
  });

  it("reads the profile, ignores other tools' keys, and keeps the body as the brief", () => {
    expect(
      AgentRoles.parseAgentRoleFile(
        "engineer.md",
        "---\nname: engineer\ntitle: Engineer\nprovider: codex\nmodel: gpt-6.2-sol\nruntime_mode: auto-accept-edits\nallow: ['@reviewer', qa]\nskills: [adapt-app]\ntools: [delegate_task, 't3_thread_*']\ncolor: red\n---\n\nYou build the app.\n",
      ),
    ).toEqual({
      role: {
        name: "engineer",
        title: "Engineer",
        provider: "codex",
        model: "gpt-6.2-sol",
        runtimeMode: "auto-accept-edits",
        allow: ["reviewer", "qa"],
        skills: ["adapt-app"],
        tools: ["delegate_task", "t3_thread_*"],
        instructions: "You build the app.",
      },
    });
    expect(AgentRoles.parseAgentRoleFile("qa.md", "Just a brief.")).toEqual({
      role: { name: "qa", title: "qa", instructions: "Just a brief." },
    });
  });
});

describe("roleToolAllowed", () => {
  it.each([
    [undefined, "schedule_task", true],
    [["delegate_task"], "delegate_task", true],
    [["delegate_task"], "delegate_task_status", false],
    [["t3_thread_*"], "t3_thread_read", true],
    [["t3_thread_*"], "t3_project_list", false],
    [[], "delegate_task", false],
  ] as const)("%j allows %s: %s", (patterns, tool, allowed) => {
    expect(AgentRoles.roleToolAllowed(patterns, tool)).toBe(allowed);
  });
});

describe("resolveRequestedRole", () => {
  const role = (name: string, allow?: ReadonlyArray<string>) =>
    ({ name, title: name, instructions: "", ...(allow ? { allow } : {}) }) as const;
  const roles = [role("producer", ["engineer"]), role("engineer", []), role("qa")];

  it.each([
    [undefined, "@engineer", "engineer"],
    ["producer", "engineer", "engineer"],
    ["qa", "producer", "producer"],
    ["producer", "qa", "may hand work only to @engineer, not @qa"],
    ["engineer", "qa", "@engineer may not hand work to other roles"],
    [undefined, "designer", 'Role "designer" is not defined'],
  ])("caller %s asking for %s gives %s", (callerRole, requested, expected) => {
    const result = AgentRoles.resolveRequestedRole({
      roles: roles as never,
      callerRole,
      requested,
    });
    expect("role" in result ? result.role.name : result.problem).toContain(expected);
  });
});

it.layer(layerTest)("AgentRoles", (it) => {
  it.effect("lists valid roles and reports broken files and unknown reach as problems", () =>
    Effect.gen(function* () {
      const cwd = yield* checkoutWithRoles({
        "producer.md": "---\nallow: [engineer, designer]\n---\nShip one app.",
        "engineer.md": "Build it.",
        "broken.md": "---\nruntime_mode: [\n---\n",
        "notes.txt": "ignored",
      });
      const agentRoles = yield* AgentRoles.AgentRoles;

      const catalog = yield* agentRoles.list(cwd);

      expect(catalog.roles.map((role) => role.name)).toEqual(["engineer", "producer"]);
      expect(catalog.problems.map((problem) => problem.file)).toEqual([
        ".agents/roles/broken.md",
        ".agents/roles/producer.md",
      ]);
      expect(catalog.problems[1]?.message).toContain("designer");
      expect((yield* agentRoles.get(cwd, "engineer"))?.instructions).toBe("Build it.");
      expect(yield* agentRoles.get(cwd, "../engineer")).toBeUndefined();
      expect(yield* agentRoles.list(`${cwd}/missing`)).toEqual({ roles: [], problems: [] });
    }),
  );
});
