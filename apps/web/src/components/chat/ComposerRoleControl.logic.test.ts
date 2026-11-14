import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAgentRoleModelSelection } from "./ComposerRoleControl.logic";

function entry(
  instanceId: string,
  driverKind: string,
  slugs: ReadonlyArray<string>,
  overrides: { isDefault?: boolean; isAvailable?: boolean; aliases?: ReadonlyArray<string> } = {},
) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driverKind),
    enabled: true,
    isAvailable: overrides.isAvailable ?? true,
    isDefault: overrides.isDefault ?? false,
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(overrides.aliases ? { aliases: [...overrides.aliases] } : {}),
    })),
  };
}

describe("resolveAgentRoleModelSelection", () => {
  const entries = [
    entry("codex", "codex", ["gpt-5"]),
    entry("claude-work", "claudeAgent", ["opus"]),
    entry("claudeAgent", "claudeAgent", ["opus", "sonnet"], { isDefault: true }),
    entry("offline", "claudeAgent", ["haiku"], { isAvailable: false }),
  ];

  it.each([
    ["no model", {}, null],
    ["a model alone, on the default instance", { model: "opus" }, ["claudeAgent", "opus"]],
    [
      "a driver kind, on its default instance",
      { provider: "claudeAgent", model: "opus" },
      ["claudeAgent", "opus"],
    ],
    [
      "an instance id over a driver kind",
      { provider: "claude-work", model: "opus" },
      ["claude-work", "opus"],
    ],
    ["a model the named provider lacks", { provider: "codex", model: "opus" }, null],
    ["a model only an unavailable instance has", { model: "haiku" }, null],
    ["an unknown model", { model: "nope" }, null],
  ] as const)("resolves %s", (_name, role, expected) => {
    expect(resolveAgentRoleModelSelection(role, entries)).toEqual(
      expected === null ? null : { instanceId: expected[0], model: expected[1] },
    );
  });

  it("matches an alias and returns the canonical slug", () => {
    expect(
      resolveAgentRoleModelSelection({ model: "latest" }, [
        entry("codex", "codex", ["gpt-5"], { aliases: ["latest"] }),
      ]),
    ).toEqual({ instanceId: "codex", model: "gpt-5" });
  });
});
