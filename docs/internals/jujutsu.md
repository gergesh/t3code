# Jujutsu

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.
A missing directory returns no marker root; it cannot climb into an unrelated repository above it.
Marker discovery and synchronous repository identity resolve real paths before walking, so aliases
retain the same nearest-marker boundary.
[`VcsProjectConfig`](../../apps/server/src/vcs/VcsProjectConfig.ts) resolves the repository's
`.t3code/vcs.json` preference before driver detection. A Git pin selects Git without a notice;
callers that only probe for jj get no handle for a Git pin, without spawning Git or jj.
A jj pin selects jj without automatic fallback; auto and unknown use nearest-marker detection and fallback.
**Known gap:** jj automatically tracks this configuration file, so the preference can land in pushes.
Missing, too-old, or broken jj falls back only to usable Git at that colocated root, with an
optional informational `vcs: { kind: "git", notice }` status descriptor. Broken-probe notices
include the first real error line of jj's diagnostic, skipping blank, `Warning:` and `Hint:` lines.
Ordinary Git omits the descriptor; a notice never
disables actions. Explicit Git or jj API driver requests bypass automatic fallback; unknown behaves as auto.
Automatic Git fallback uses the bounded detection cache and canonicalizes both roots before
checking colocation. Availability checks invalidate cached probes when the resolved executable path
or modification time changes; successful probes expire after five minutes and failed probes after
30 seconds. A Settings rescan refreshes immediately.
Non-colocated repositories report the colocation requirement first, followed by the precise
server PATH diagnostic and installation/rescan advice when jj is also missing.
Onboarding excludes unregistered secondary jj workspaces, including nested paths and symlink aliases.

## `git.abandon-unreachable-commits=false` on every command we run

A colocated repository imports Git refs during jj commands. The default unreachable-commit abandonment can rewrite local history after an external Git ref moves. [`JjProcess.ts`](../../apps/server/src/vcs/JjProcess.ts) passes `git.abandon-unreachable-commits=false` on T3 Code's jj commands so a later status read does not abandon that history. This does not change the user's jj configuration.

## Repository-local configuration and machine output

Availability probes are cached per repository, not globally: a broken repository configuration
must not disable Jujutsu in another checkout. Failed probes retain jj's stderr rather than
reporting an installed binary as missing.

Machine templates access keywords through `self` methods so user keyword aliases cannot shadow
them. If configuration changes a template function's output, decoding reports the failing field
path without including the output value.

## Checkpoints are raw refs

A checkpoint captures the commit id of `@` and pins it under `refs/t3/` with `git update-ref --create-reflog`. It moves neither the working-copy change nor a bookmark. Bookmarks and tags would appear in ref pickers, `jj commit` would advance `@` every turn, and operation ids stop resolving after operation-log pruning. The ref format stays shared through [`checkpointRefForThreadTurn`](../../apps/server/src/checkpointing/Utils.ts).

What it doesn't give you is jj addressability. After an op log prune the object is still pinned in
Git but jj has forgotten it, so `jj restore --from <id>` fails with `Revision ... doesn't exist`.
Restore recovers by writing a temporary `refs/heads/t3-restore-<uuid>`, running `jj git import`,
and retrying. Cleanup forgets the temporary bookmark, deletes its Git ref, and abandons the
recovery commit and any hidden ancestors revived by import, excluding history visible at the
pre-import operation. Cleanup also runs if import completes just before interruption; a
`present()` revset makes an import that never completed safe to clean up. Every cleanup is
attempted, and the primary failure plus all cleanup failures are retained in the returned cause.
See [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts).

Capture snapshots `@` and pins its object. Checkpoint restore uses `jj restore`, not `git reset`,
`git clean` or `git restore`, so the change id, description, bookmarks and other workspaces
survive. Ordinary restores can be undone with `jj undo`; recovery also records import and cleanup
operations, so use the operation log to select the restore when undoing recovery. Checkpoint code
never abandons the user's changes or prunes the operation log.

Both endpoints of a jj checkpoint diff must be captured refs. Missing-ref restore returns false;
a missing diff endpoint is an error. The shared fallback options remain for the upstream Git
driver, but jj does not substitute a parent tree for a missing checkpoint. Captured merge trees
use the same Git patch and rename-aware NUL-delimited numstat path as other captured trees.

## Turn attribution is separate from restore

The upstream checkpoint pipeline can filter turn diffs to authored paths without narrowing the saved checkpoint. jj implements `listAuthoredPaths` in [`JjCheckpoints.ts`](../../apps/server/src/vcs/JjCheckpoints.ts): it combines working-copy edits at both ends with paths from relevant parent history, using the starting checkpoint's reflog timestamp rather than the jj commit timestamp as capture time. That keeps imported history from becoming the turn's own work.

Ambiguous ancestry, unchanged parents or older refs without capture-time metadata return `null` instead of guessing an authored-path set. Diff filtering is optional; restore always uses the full captured workspace.

## Root is never a revision

jj's synthetic root has an all-zeros id, not a usable Git object. [`JjVcsDriver.ts`](../../apps/server/src/vcs/JjVcsDriver.ts) drops root parents and returns `null` when `changeAt` resolves root. A first change therefore has `parentCommitIds: []`. Review diffs use Git's empty tree when they need an empty base. Default-bookmark, review-diff base and remote-tracking resolution must treat root as absent, never pass its zero id to Git.

Remote-qualified review bases such as `origin/main`, including `branch.<name>.gh-merge-base`,
try the remote bookmark first, then the same-spelled local bookmark only if the remote is absent.
`refs/remotes/origin/main` stays remote-only; `refs/heads/origin/main` explicitly selects local.

## jj owns the working copy, Git owns the object store

In a colocated repo every jj commit, `@` included, is a real Git object in
`<mainWorkspaceRoot>/.git` pinned by `refs/jj/keep/<sha>`. So the split is fixed:

- Snapshot and restore are jj only. Git's `HEAD` is not the working-copy change `@`; `git restore` or `git clean` bypasses jj's working-copy state even in a colocated secondary workspace.
- Checkpoint diffs use Git plumbing between captured trees, including captured merges. Review diffs use Git plumbing for single-parent changes and `jj diff --git` for merged-parent baselines, retaining rename pairs in numstat metadata.
- Hosting operations and per-thread merge-base config use the main workspace root and its `.git/config`. Local bookmarks are exported as Git branch refs in the colocated store. Explicit fetch, push and bookmark movement belong to jj, not Git checkout commands. Background status fetches use Git with noninteractive authentication and write only `refs/t3/remotes/<encoded-remote>/*`, a namespace jj does not import. Fetch disables Git's configured remote-tracking ref mappings as well. Ahead counts use jj's nonempty changes above the Git merge bases; behind counts read the fetched Git objects. A background remote update therefore cannot move a tracked local bookmark or detach the workspace from it.

Hence the scope limit: a jj repo with no reachable `.git` is detected as jj and reported unusable,
never quietly treated as Git. [`JjRepo.resolveJjRepoPaths`](../../apps/server/src/vcs/JjRepo.ts)
follows a secondary workspace's `.jj/repo` pointer back to the main root so every Git call still has
a `--git-dir`.

Private behind counts are bounded by time, output size and commit count. Timeouts and output limits retain jj's known remote-bookmark count. Reaching the commit cap reports a lower bound of 1000 rather than a potentially stale zero, so Pull remains available. Remote discovery failures still surface as errors.
Upstream ahead counts start at `@` and exclude empty local changes; behind counts start at the
selected local bookmark and include empty remote commits. Automatic pull never applies to jj.

Status snapshot, segment, bookmark and workspace read failures propagate to the caller; they never
become a clean working-copy result. The broadcaster's paired reads share lazy segment and workspace
listings within one refresh, including cache misses and remote-triggered local refreshes. A post-pull
pair starts a new scope; reads never survive a mutation or leak into another refresh. Git retains its
existing call order and options. Optional branch totals alone are absent for unrelated histories:
only after a failed triple-dot diff does a successful no-common-ancestor diagnostic establish this.
Broken commands, missing objects, timeouts and other genuine failures still surface.
The refs snapshot cache includes repository generation and operation-head identities, so external
`jj` operations invalidate it immediately. Each bookmark mutation invalidates once. T3 workspace
creation, removal and pruning also advance the repository generation, including when a later
configuration step fails. Fresh workspaces leave `@`'s description empty so user-written descriptions
can always be preserved and cleanup can dispose of empty, undescribed changes. Force removal deletes
the workspace directory. Only snapshotted changes are retained in Jujutsu history; ignored files and
files excluded by snapshot size limits may be lost.

The registry is the only activation boundary: commits 1–6 register only Git, and activation registers
jj and adds jj-first detection. Callers use the detected kind rather than a rollout flag. Cleanup
preserves `.jj` metadata whenever detection does not select jj.

## Commit, push and pull preserve the user's change

Managed workspaces use their own bookmark. Other workspaces first use the nearest eligible
bookmarked descendant of `@`, then the nearest bookmarked ancestor. Multiple eligible descendant
branches or names on one change are refused as ambiguous, never silently selected or redirected
to `main`. Editing `main <- x1(@) <- x2[feat]` therefore commits and pushes `feat`, never `main`;
bookmark movement retains the descendant tip instead of rewinding it to `@-`. Push-only and
create-change-request actions refuse if the selected bookmark includes the current `@` anywhere
in its ancestry: commit the change first. Commit-and-push remains supported mid-stack.

Commit uses the typed message when nonblank, then the existing change description, then generated
text. The selected text retains its exact trimmed formatting; a new bookmark derives its name from
that same text. Push-only bookmark names use `@-`'s description, not dirty `@`.
Conflicted working-copy changes are refused before commit or push. Pull refuses unpublished commits,
including commits above the bookmark, but not dirty files alone. It rebases with
`jj rebase -s @ -d <bookmark>` so unbookmarked descendants move with the change.
Pull creates an empty working-copy child of the updated bookmark when editing its old pushed target,
so the next edit cannot rewrite published work. An intentionally edited earlier ancestor stays in
place instead of rebasing onto its own descendant. When a local amend rewrites the remote bookmark's
target, Pull refuses with push guidance rather than rebasing the change onto its own predecessor.

Publishing adds the remote before pushing. An actual first-push transport failure uses the same
bounded hosting guidance as Git publishing, including the actual allocated remote name, and
preserves that guidance through the public repository-service error. Local jj preflight refusals,
such as an undescribed change, retain their actionable explanation instead. The remote remains
for retry. Git's error mapper and publishing implementation are unchanged.

## Unavailable and unsupported repositories

Missing `jj` or a version older than 0.46.0
([`JJ_MINIMUM_VERSION`](../../apps/server/src/vcs/JjAvailability.ts)) selects Git only when a usable
Git checkout exists at the same colocated root. Status includes an informational Git notice;
actions remain available. Broken installation or configuration errors also fall back when
colocated Git is usable, with the first real error line in the notice (skipping `Warning:` and `Hint:` lines).
An explicit jj preference refuses broken jj through the same wire-safe unsupported path, using
the notice's diagnostic text without the Git-fallback sentence; status retains jj and that reason.
Automatic detection also retains Git when a user initializes jj inside a Git linked worktree
(the `.git` gitdir file points to shared `commondir` metadata, unlike a submodule or separate Git directory).
The notice explains that jj in linked Git worktrees is unsupported. An explicit jj pin still
refuses, with the same explanation. Neither path recommends enabling colocation, which cannot turn
that checkout into a supported jj workspace. The Git fallback must resolve to the same workspace root.

Fallback notices say when Git is detached: commits won't be on a branch; push needs a branch.
Web renders the notice in ChatView's banner lane; mobile renders a dismissible thread notice.
Dismissals persist per environment and repository and are invalidated when either notice text or
reason changes. Unsupported reasons remain visible and cannot be dismissed.

Without usable colocated Git, detection still says jj. Operations refuse with a named
`VcsStatusLocalResult.vcs.unsupportedReason`. Web and mobile disable source-control actions,
Changes, bookmark/workspace selection and creation, and queued setup dispatch for this unsupported
descriptor only. Already-open dialogs recheck support before dispatch. Missing or loading status
alone does not disable otherwise available controls. Mobile can leave an unsupported saved or default
workspace selection for local chat; only entering workspace mode requires source-control support.

Fresh drafts keep main's controls and subscription keys; they do not add a status stream to predict
server support. Workspace creation refuses before allocating a workspace, and first send checks
usability before creating a thread, claiming attachments, or allocating managed folders. Both clients
show the existing unsupported reason from the refusal and retain the draft for correction. The
first-send check uses the jj-only facade, leaving Git draft creation on its existing path.

For an existing non-colocated repository, run `jj git colocation enable` in its main workspace.
Publishing checks detection and usability before allocating a hosted repository. Git publishing
keeps its original order and performs no jj probe.

Client action rules live in `packages/client-runtime/src/state/gitActions.ts`. The explicit surface
policy preserves web publishing and dirty-tree push behavior and mobile's clean-tree push rule,
View PR entry and no-publishing behavior. Shared terminology objects supply system-specific copy;
the web terminology subscription selects their stable identities instead of every status refresh.
Selected-thread mobile controls select stable terminology, kind and unsupported-reason values from
the existing full-status stream rather than opening a second local-status stream for the same checkout.

Checkpoints are the exception. `checkpointsUsable` answers `false` there so
[`CheckpointStore.supportsCheckpoints`](../../apps/server/src/checkpointing/CheckpointStore.ts) skips
capture silently, same as a directory with no repo, instead of writing a failed-capture activity into
every turn.
