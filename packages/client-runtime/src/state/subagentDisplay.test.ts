import { ProjectId } from "@t3tools/contracts";
import { JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { describe, expect, it } from "vite-plus/test";

import { resolveSubagentMetadata, subagentDetailPreview } from "./subagentDisplay.js";

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});

it.each([279, 280, 281])("preserves the preview boundary at %i characters", (length) => {
  const result = "x".repeat(length);
  expect(subagentDetailPreview({ status: "completed", result })).toBe(
    length > 280 ? "x".repeat(280) + "…" : result,
  );
});

it("normalizes Unicode whitespace and ignores a large hidden suffix", () => {
  const progress = "  Reading\tfiles\n" + "x".repeat(1_000_000);
  expect(subagentDetailPreview({ status: "running", progress })).toBe(
    "Reading files " + "x".repeat(266) + "…",
  );
  expect(
    subagentDetailPreview({ status: "completed", result: "x".repeat(280) + " \n " }),
  ).toBe("x".repeat(280));
  expect(subagentDetailPreview({ status: "completed", result: "x".repeat(279) + " \n y" })).toBe(
    "x".repeat(279) + "…",
  );
  expect(
    subagentDetailPreview({ status: "running", progress: "﻿ ", result: " Done " }),
  ).toBe("Done");
  expect(subagentDetailPreview({ status: "failed", result: "x".repeat(279) + "😀" })).toBe(
    "x".repeat(279) + "…",
  );
});

describe("resolveSubagentMetadata", () => {
  const parentThread = { projectId: ProjectId.make("parent"), worktreePath: null };
  const parentProject = { workspaceRoot: "/repo" };

  it("uses jj terminology without changing the workspace metadata kinds", () => {
    const input = {
      model: null,
      parentThread,
      parentProject,
      terminology: JJ_VCS_TERMINOLOGY,
    };
    expect(
      resolveSubagentMetadata({
        ...input,
        childThread: { branch: "fix/agents", worktreePath: "/workspaces/agents" },
      }).workspace,
    ).toEqual([{ kind: "ref", label: "Bookmark", value: "fix/agents" }]);
    expect(
      resolveSubagentMetadata({
        ...input,
        childThread: { branch: null, worktreePath: "/workspaces/agents" },
      }).workspace,
    ).toEqual([{ kind: "workspace", label: "Workspace", value: "agents" }]);
  });
});
