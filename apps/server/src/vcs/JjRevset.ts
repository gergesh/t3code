/**
 * `listRefs` emits git-shaped `<remote>/<name>` rows so the shared client helpers keep working, and
 * the clients hand those names straight back to `switchRef` / `createWorktree`. jj cannot resolve
 * `origin/main` (its form is `main@origin`), so every name-to-revset conversion goes through here.
 */

import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/;
const CHANGE_ID_PATTERN = /^[k-z]{32}$/;

/** Escapes `\` and `"` for a jj string literal. */
function escapeRevsetString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Creation and update commands parse bookmark names as symbols, not raw strings. */
export function bookmarkNameArgument(name: string): string {
  return `"${escapeRevsetString(name)}"`;
}

/** Match one literal bookmark or remote in CLI options that otherwise parse string expressions. */
export function exactStringPattern(value: string): string {
  return `exact:${bookmarkNameArgument(value)}`;
}

/** Splits `origin/feature/x` into `{ remote: "origin", name: "feature/x" }` for a known remote. */
export function splitRemoteRefName(
  refName: string,
  remoteNames: ReadonlyArray<string>,
): { readonly remote: string; readonly name: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(
    refName,
    remoteNames.toSorted((a, b) => b.length - a.length),
  );
  return parsed === null ? null : { remote: parsed.remoteName, name: parsed.branchName };
}

/**
 * `file:"<escaped>"` is jj's literal fileset form, git's `--literal-pathspecs` equivalent. Bare
 * arguments are parsed as fileset *expressions*, so `a~b` silently becomes a difference and
 * `a (1).png` fails to parse; a bare leading `-` is parsed as an option instead of a path.
 */
export function literalFilesetPath(filePath: string): string {
  return `file:"${escapeRevsetString(filePath)}"`;
}

/** `bookmarks(exact:"<escaped>")` resolves a local bookmark unambiguously. */
export function localBookmarkRevset(name: string): string {
  return `bookmarks(exact:"${escapeRevsetString(name)}")`;
}

/** Quoted bookmark and remote names stay literal rather than becoming revset operators. */
export function remoteBookmarkRevset(remote: string, name: string): string {
  return `"${escapeRevsetString(name)}"@"${escapeRevsetString(remote)}"`;
}

/**
 * `<workspace>@` is jj's own spelling of a workspace's working copy. `listRefs` uses it for a
 * workspace no bookmark names; `@` is not valid in a bookmark name, so it cannot collide.
 */
export function workspaceRefName(workspaceName: string): string {
  return `${workspaceName}@`;
}

/** The workspace name behind a {@link workspaceRefName} ref, or `null` for any other ref. */
export function parseWorkspaceRefName(refName: string): string | null {
  return refName.length > 1 && refName.endsWith("@") ? refName.slice(0, -1) : null;
}

/**
 * Client ref name to jj revset. A commit id or change id is returned unchanged so a base handed
 * over the wire as a revision still resolves.
 */
export function refNameToRevset(refName: string, remoteNames: ReadonlyArray<string>): string {
  const remoteRef = splitRemoteRefName(refName, remoteNames);
  if (remoteRef) {
    return remoteBookmarkRevset(remoteRef.remote, remoteRef.name);
  }
  const workspaceName = parseWorkspaceRefName(refName);
  if (workspaceName !== null) {
    return `"${escapeRevsetString(workspaceName)}"@`;
  }
  if (COMMIT_ID_PATTERN.test(refName) || CHANGE_ID_PATTERN.test(refName)) {
    return refName;
  }
  return localBookmarkRevset(refName);
}
