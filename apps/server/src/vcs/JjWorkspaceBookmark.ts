/**
 * The bookmark a T3 workspace's thread works on, recorded in the colocated git config. A new
 * workspace has no bookmark until its first commit or push, and its name is a digest of the
 * bookmark, so this record is the only way back from a workspace to its thread's name.
 */
import * as Effect from "effect/Effect";

import * as JjProcess from "./JjProcess.ts";
import type * as VcsProcess from "./VcsProcess.ts";

interface RecordInput extends JjProcess.ColocatedGitInput {
  readonly workspaceName: string;
}

const configKey = (workspaceName: string) => `t3-workspace.${workspaceName}.bookmark`;

const git = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  input: RecordInput,
  args: ReadonlyArray<string>,
) =>
  JjProcess.colocatedGitCommand(
    process,
    operation,
    { gitDir: input.gitDir, cwd: input.cwd },
    ["config", ...args],
    { allowNonZeroExit: true, timeoutMs: 10_000 },
  );

export const readWorkspaceBookmark = (
  process: VcsProcess.VcsProcess["Service"],
  input: RecordInput,
): Effect.Effect<string | null> =>
  git(process, "JjWorkspaceBookmark.read", input, ["--get", configKey(input.workspaceName)]).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
    Effect.orElseSucceed(() => null),
  );

export const writeWorkspaceBookmark = (
  process: VcsProcess.VcsProcess["Service"],
  input: RecordInput & { readonly bookmark: string },
): Effect.Effect<void> =>
  git(process, "JjWorkspaceBookmark.write", input, [
    configKey(input.workspaceName),
    input.bookmark,
  ]).pipe(Effect.ignore);

/** Removes the whole section, so a forgotten workspace leaves nothing behind. */
export const clearWorkspaceBookmark = (
  process: VcsProcess.VcsProcess["Service"],
  input: RecordInput,
): Effect.Effect<void> =>
  git(process, "JjWorkspaceBookmark.clear", input, [
    "--remove-section",
    `t3-workspace.${input.workspaceName}`,
  ]).pipe(Effect.ignore);
