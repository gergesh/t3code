import { VcsStatusLocalResult } from "./git.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
} from "./git.ts";
import { PullRequestDiffFileContentsInput } from "./pullRequest.ts";
import { ReviewDiffFileContentsInput } from "./review.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const encodeRunStackedActionInput = Schema.encodeUnknownSync(GitRunStackedActionInput);
const decodeReviewDiffFileContentsInput = Schema.decodeUnknownSync(ReviewDiffFileContentsInput);
const encodeReviewDiffFileContentsInput = Schema.encodeUnknownSync(ReviewDiffFileContentsInput);
const decodePullRequestDiffFileContentsInput = Schema.decodeUnknownSync(
  PullRequestDiffFileContentsInput,
);
const encodePullRequestDiffFileContentsInput = Schema.encodeUnknownSync(
  PullRequestDiffFileContentsInput,
);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("Git file paths", () => {
  it.each([
    {
      operation: "commit",
      decode: decodeRunStackedActionInput,
      encode: encodeRunStackedActionInput,
      input: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [" leading.txt", "trailing.txt "],
      },
    },
    {
      operation: "local diff expansion",
      decode: decodeReviewDiffFileContentsInput,
      encode: encodeReviewDiffFileContentsInput,
      input: {
        cwd: "/repo",
        sourceKind: "working-tree",
        changeType: "rename-changed",
        baseRef: "HEAD",
        headRef: null,
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
    {
      operation: "pull request diff expansion",
      decode: decodePullRequestDiffFileContentsInput,
      encode: encodePullRequestDiffFileContentsInput,
      input: {
        projectId: "project-1",
        repository: "owner/repo",
        number: 1,
        changeType: "rename-changed",
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
  ])("preserves leading and trailing whitespace for $operation", ({ decode, encode, input }) => {
    expect(decode(input)).toEqual(input);
    expect(encode(input)).toEqual(input);
  });
});

const decodeVcsStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);
describe("VcsStatusLocalResult", () => {
  it("accepts only supported VCS descriptors and requires informational Git notice", () => {
    const status = {
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    expect(decodeVcsStatusLocalResult({ ...status, vcs: { kind: "jj" } }).vcs?.kind).toBe("jj");
    expect(
      decodeVcsStatusLocalResult({ ...status, vcs: { kind: "git", notice: "Using Git." } }).vcs,
    ).toEqual({ kind: "git", notice: "Using Git." });
    expect(() => decodeVcsStatusLocalResult({ ...status, vcs: { kind: "unknown" } })).toThrow();
    expect(() => decodeVcsStatusLocalResult({ ...status, vcs: { kind: "git" } })).toThrow();
    expect(decodeVcsStatusLocalResult(status).vcs).toBeUndefined();
  });
});
