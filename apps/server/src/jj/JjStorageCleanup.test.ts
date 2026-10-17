import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import {
  commitId,
  describeJj,
  runGit,
  runJj,
  withJjRepo,
  type JjRepoFixture,
} from "../vcs/testing/JjTestSupport.ts";
import { inspectJjStorageCleanup, removeJjStorageCleanup } from "./JjStorageCleanup.ts";
import { makeJjWorkspaces, workspaceNameForRef, workspacePruneLock } from "./JjWorkspaces.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import * as JjProcess from "../vcs/JjProcess.ts";

const bookmark = "feature/cleanup";
const withWorkspace = <A, E>(
  use: (
    repo: JjRepoFixture & { readonly cwd: string },
  ) => Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer>>,
) =>
  withJjRepo({ prefix: "t3-jj-storage-cleanup-", seed: true }, (repo) =>
    Effect.gen(function* () {
      const cwd = repo.path.join(repo.base, "workspace");
      yield* runJj(repo.root, ["bookmark", "create", bookmark, "-r", "main"]);
      yield* runJj(repo.root, [
        "workspace",
        "add",
        "--colocate",
        "--name",
        workspaceNameForRef(bookmark),
        "-r",
        bookmark,
        cwd,
      ]);
      return yield* use({ ...repo, cwd });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describeJj("JjStorageCleanup", () => {
  it.effect("removes an idle empty workspace on its bookmarked parent", () =>
    withWorkspace(({ cwd, root, driver, fileSystem }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.equal(inspected.commitId, yield* commitId(cwd, "@-"));
        assert.equal(inspected.defaultBranch, "main");
        assert.isTrue(inspected.integrated);
        assert.equal(inspected.mainWorkspaceRoot, root);
        assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isFalse(yield* fileSystem.exists(cwd));
        assert.isFalse((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
        assert.isTrue(yield* fileSystem.exists(root));
        yield* runJj(root, [
          "workspace",
          "add",
          "--colocate",
          "--name",
          workspaceNameForRef(bookmark),
          "-r",
          bookmark,
          cwd,
        ]);
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.lengthOf(
          (yield* driver.listWorkspaces(root)).filter((entry) => entry.root === cwd),
          1,
        );
      }),
    ),
  );

  it.effect("does not label concurrent snapshot modification as a stale workspace", () =>
    withWorkspace(({ cwd, fileSystem }) =>
      Effect.gen(function* () {
        const command = JjProcess.jjCommand;
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(JjProcess, "jjCommand").mockImplementation((...args) =>
              command(...args).pipe(
                Effect.map((result) =>
                  args[3][0] === "status"
                    ? {
                        ...result,
                        exitCode: ChildProcessSpawner.ExitCode(1),
                        stderr: "Error: Concurrent modification detected",
                      }
                    : result,
                ),
              ),
            ),
          ),
          () =>
            Effect.gen(function* () {
              assert.equal(
                (yield* inspectJjStorageCleanup(cwd, bookmark)).reason,
                "working-copy snapshot failed",
              );
              assert.isTrue(yield* fileSystem.exists(cwd));
            }),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
      }),
    ),
  );

  it.effect("keeps a stale workspace without rewriting unsnapshotted files", () =>
    withWorkspace(({ cwd, root, fileSystem, path }) =>
      Effect.gen(function* () {
        const parent = yield* commitId(cwd, "@-");
        yield* fileSystem.writeFileString(path.join(root, "destination.txt"), "destination\n");
        yield* runJj(root, ["commit", "-m", "new destination"]);
        const destination = yield* commitId(root, "@-");
        yield* fileSystem.writeFileString(path.join(cwd, "seed.txt"), "unsnapshotted edit\n");
        yield* fileSystem.writeFileString(path.join(cwd, "new.txt"), "unsnapshotted new file\n");
        yield* runJj(root, [
          "rebase",
          "-s",
          `${workspaceNameForRef(bookmark)}@`,
          "-d",
          destination,
        ]);
        assert.equal((yield* inspectJjStorageCleanup(cwd, bookmark)).reason, "workspace is stale");
        assert.equal(yield* removeJjStorageCleanup(cwd, bookmark, parent), "workspace is stale");
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "seed.txt")),
          "unsnapshotted edit\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "new.txt")),
          "unsnapshotted new file\n",
        );
        assert.isFalse(yield* fileSystem.exists(path.join(cwd, "destination.txt")));
      }),
    ),
  );

  it.effect("refreshes cleanup refs for an option-like remote name", () =>
    withWorkspace(({ cwd, root, remotePath, fileSystem }) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(remotePath);
        yield* runGit(remotePath, ["init", "--bare", "--initial-branch=main"]);
        const parent = yield* commitId(cwd, "@-");
        yield* runGit(root, ["push", remotePath, `${parent}:refs/heads/main`]);
        yield* runGit(root, ["config", "remote.-x.url", remotePath]);
        yield* runGit(root, ["config", "remote.-x.fetch", "+refs/heads/*:refs/remotes/-x/*"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, undefined, true);
        assert.isNull(inspected.reason);
        assert.equal(inspected.defaultBranch, "main");
        assert.isTrue(inspected.integrated);
        assert.equal(
          (yield* runGit(root, ["rev-parse", "refs/t3/remotes/-x/main"])).trim(),
          parent,
        );
      }),
    ),
  );

  it.effect("keeps an empty working copy with a user description", () =>
    withWorkspace(({ cwd, root, driver, fileSystem }) =>
      Effect.gen(function* () {
        const description = "user-authored cleanup notes";
        yield* runJj(cwd, ["describe", "-m", description]);
        const change = yield* driver.changeAt(cwd, "@");
        assert.isNotNull(change);
        assert.isTrue(change!.empty);
        const reason = yield* removeJjStorageCleanup(cwd, bookmark, yield* commitId(cwd, "@-"));
        assert.equal(reason, "has a working-copy description");
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.isTrue((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
        assert.equal((yield* driver.changeAt(cwd, "@"))?.description, `${description}\n`);
        assert.equal(
          (yield* inspectJjStorageCleanup(cwd, bookmark)).reason,
          "has a working-copy description",
        );
      }),
    ),
  );

  it.effect("preserves a description arriving after removal inspection at the final guard", () =>
    withWorkspace(({ cwd, root, base, driver, fileSystem, path }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        const workspaceRevision = `${workspaceNameForRef(bookmark)}@`;
        const before = yield* commitId(root, workspaceRevision);
        const shim = path.join(base, "jj-final-guard");
        const firstRead = path.join(base, "first-workspace-read");
        const injected = path.join(base, "description-injected");
        const description = "description arriving at the final cleanup guard";
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        yield* fileSystem.writeFileString(
          shim,
          `#!/bin/sh
set -eu
real_jj=$(command -v jj)
is_log=false
is_workspace=false
for arg in "$@"; do
  [ "$arg" != log ] || is_log=true
  [ "$arg" != ${quote(workspaceRevision)} ] || is_workspace=true
done
if "$is_log" && "$is_workspace"; then
  if [ ! -f ${quote(firstRead)} ]; then
    : > ${quote(firstRead)}
  else
    # The removal's own inspection and baseline read have finished. The
    # workspace has been held aside, so only the final metadata guard can save it.
    [ ! -d ${quote(cwd)} ]
    "$real_jj" --no-pager --color=never --ignore-working-copy -R ${quote(root)} describe -r ${quote(workspaceRevision)} -m ${quote(description)}
    : > ${quote(injected)}
  fi
fi
exec "$real_jj" "$@"
`,
        );
        yield* fileSystem.chmod(shim, 0o755);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const wrappedSpawner = ChildProcessSpawner.make((command) =>
          spawner.spawn(
            command._tag === "StandardCommand" && command.command === "jj"
              ? { ...command, command: shim }
              : command,
          ),
        );
        const reason = yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId).pipe(
          Effect.provide(Layer.empty, { local: true }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrappedSpawner),
        );
        assert.isTrue(yield* fileSystem.exists(firstRead));
        assert.isTrue(yield* fileSystem.exists(injected));
        assert.equal(reason, "workspace changed since inspection");
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.isTrue((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
        const change = yield* driver.changeAt(cwd, "@");
        assert.isNotNull(change);
        assert.notEqual(change!.commitId, before);
        assert.equal(change!.description, `${description}\n`);
        assert.equal(yield* fileSystem.readFileString(path.join(cwd, "seed.txt")), "seed\n");
      }),
    ),
  );

  it.effect.each([false, true])(
    "does not mistake local main for the remote default (exists=%s)",
    (defaultExists) =>
      withWorkspace(({ cwd, root, remotePath, fileSystem, path }) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(remotePath);
          yield* runGit(remotePath, ["init", "--bare", "--initial-branch=develop"]);
          yield* runJj(root, ["git", "remote", "add", "origin", remotePath]);
          const base = yield* commitId(root, "main");
          if (defaultExists) yield* runGit(root, ["push", "origin", `${base}:refs/heads/develop`]);
          yield* fileSystem.writeFileString(path.join(cwd, "feature.txt"), "not integrated\n");
          yield* runJj(cwd, ["commit", "-m", "feature"]);
          yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
          const feature = yield* commitId(cwd, "@-");
          yield* runJj(root, ["bookmark", "move", "main", "--to", feature]);
          yield* runGit(root, ["push", "origin", `${feature}:refs/heads/main`]);
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, undefined, true);
          assert.isNull(inspected.reason);
          assert.equal(inspected.defaultBranch, defaultExists ? "develop" : null);
          assert.isFalse(inspected.integrated);
          assert.isTrue(yield* fileSystem.exists(cwd));
        }),
      ),
  );

  it.effect.each([false, true])(
    "caches remote default discovery for one cleanup run (exists=%s)",
    (defaultExists) =>
      withWorkspace(({ cwd, root, remotePath, fileSystem }) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(remotePath);
          yield* runGit(remotePath, ["init", "--bare", "--initial-branch=main"]);
          yield* runJj(root, ["git", "remote", "add", "origin", remotePath]);
          if (defaultExists)
            yield* runGit(root, [
              "push",
              "origin",
              `${yield* commitId(root, "main")}:refs/heads/main`,
            ]);
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          let discoveries = 0;
          let modeInspections = 0;
          const wrappedSpawner = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.command === "git") {
              if (command.args.includes("ls-remote")) {
                discoveries++;
                for (const [key, value] of Object.entries(STATUS_UPSTREAM_REFRESH_ENV))
                  assert.equal(command.options.env?.[key], value);
              }
              if (command.args.includes("ls-files") && !command.args.includes("--others")) {
                assert.include(command.args, "--stage");
                assert.include(command.args, "-z");
                assert.notInclude(command.args, "--format=%(objectmode)");
                modeInspections++;
              }
            }
            return spawner.spawn(command);
          });
          yield* Effect.gen(function* () {
            const defaultBranches = new Map<string, string | null>();
            const inspected = yield* inspectJjStorageCleanup(
              cwd,
              bookmark,
              undefined,
              false,
              defaultBranches,
            );
            assert.isNull(inspected.reason);
            assert.equal(inspected.defaultBranch, defaultExists ? "main" : null);
            const refreshed = yield* inspectJjStorageCleanup(
              cwd,
              bookmark,
              undefined,
              true,
              defaultBranches,
            );
            assert.isNull(refreshed.reason);
            assert.equal(refreshed.defaultBranch, inspected.defaultBranch);
            assert.equal(discoveries, 1);
            assert.equal(defaultBranches.get(`${root}\0origin`), inspected.defaultBranch);
            // A new cleanup run must discover the remote HEAD again.
            yield* inspectJjStorageCleanup(cwd, bookmark, undefined, false, new Map());
            assert.equal(discoveries, 2);
            assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
            assert.equal(discoveries, 2);
            assert.isAtLeast(modeInspections, 4);
          }).pipe(
            Effect.provide(Layer.empty, { local: true }),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrappedSpawner),
          );
        }),
      ),
  );

  it.effect.each(["truncated stdout", "stderr", "truncated stderr"] as const)(
    "keeps a workspace when gitlink inspection has %s",
    (failure) =>
      withWorkspace(({ cwd, fileSystem }) =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const wrappedSpawner = ChildProcessSpawner.make((command) =>
            spawner.spawn(
              command._tag === "StandardCommand" &&
                command.command === "git" &&
                command.args.includes("ls-files") &&
                !command.args.includes("--others")
                ? {
                    ...command,
                    command: "sh",
                    args: [
                      "-c",
                      {
                        "truncated stdout": "printf '%63s\\0%63s\\0' '' ''",
                        stderr: "printf 'cannot inspect index\\n' >&2",
                        "truncated stderr": "printf '%65s' '' >&2",
                      }[failure],
                    ],
                  }
                : command,
            ),
          );
          const colocatedGitCommand = JjProcess.colocatedGitCommand;
          yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              vi
                .spyOn(JjProcess, "colocatedGitCommand")
                .mockImplementation((process, operation, gitPaths, args, options) => {
                  if (args[0] !== "ls-files" || args.includes("--others"))
                    return colocatedGitCommand(process, operation, gitPaths, args, options);
                  // Exercise real truncation without allocating the production-sized listing.
                  assert.isAtLeast(options?.maxOutputBytes ?? 0, 384 * 1024 * 1024);
                  return colocatedGitCommand(process, operation, gitPaths, args, {
                    ...options,
                    maxOutputBytes: 64,
                  });
                }),
            ),
            () =>
              Effect.gen(function* () {
                const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
                assert.equal(inspected.reason, "submodules could not be inspected");
                assert.equal(
                  yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId),
                  "submodules could not be inspected",
                );
                assert.isTrue(yield* fileSystem.exists(cwd));
              }).pipe(
                Effect.provide(Layer.empty, { local: true }),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrappedSpawner),
              ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
        }),
      ),
  );

  it.effect("does not mistake mode-like text in a tracked path for a gitlink", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(
          path.join(cwd, "regular\n160000 misleading\tname"),
          "ordinary file\n",
        );
        yield* runJj(cwd, ["commit", "-m", "unusual tracked path"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isFalse(yield* fileSystem.exists(cwd));
      }),
    ),
  );

  it.effect("keeps a workspace containing a gitlink and its local submodule files", () =>
    withWorkspace(({ cwd, root, fileSystem, path }) =>
      Effect.gen(function* () {
        const base = yield* commitId(root, "main");
        const nestedName = "nested\tcheckout\nfiles";
        yield* runGit(root, ["read-tree", base]);
        yield* runGit(root, [
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${base},${nestedName}`,
        ]);
        const tree = (yield* runGit(root, ["write-tree"])).trim();
        const commit = (yield* runGit(root, [
          "-c",
          "user.name=Cleanup Test",
          "-c",
          "user.email=cleanup@example.com",
          "commit-tree",
          tree,
          "-p",
          base,
          "-m",
          "gitlink",
        ])).trim();
        yield* runGit(root, ["update-ref", `refs/heads/${bookmark}`, commit]);
        yield* runJj(cwd, ["git", "import"]);
        yield* runJj(cwd, ["new", bookmark]);
        const nested = path.join(cwd, nestedName);
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        const local = path.join(nested, "local.txt");
        yield* fileSystem.writeFileString(local, "must survive\n");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.equal(inspected.reason, "has submodules");
        assert.equal(yield* removeJjStorageCleanup(cwd, bookmark, commit), "has submodules");
        assert.equal(yield* fileSystem.readFileString(local), "must survive\n");
        assert.isTrue(yield* fileSystem.exists(cwd));
      }),
    ),
  );

  it.effect.each([false, true])(
    "refreshes cleanup refs without moving local main (diverged=%s)",
    (diverged) =>
      withWorkspace(({ cwd, root, remotePath, fileSystem, path }) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(remotePath);
          yield* runGit(remotePath, ["init", "--bare", "--initial-branch=main"]);
          yield* runJj(root, ["git", "remote", "add", "origin", remotePath]);
          yield* runJj(root, ["git", "push", "--bookmark", "main", "--remote", "origin"]);
          const localMain = yield* commitId(root, "main");
          yield* fileSystem.writeFileString(path.join(cwd, "feature.txt"), "integrated feature\n");
          yield* runJj(cwd, ["commit", "-m", "feature"]);
          yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
          const featureCommit = yield* commitId(cwd, "@-");
          yield* runGit(root, ["push", "origin", `${featureCommit}:refs/heads/main`]);
          const peer = path.join(path.dirname(remotePath), "peer");
          yield* runGit(root, ["clone", remotePath, peer]);
          yield* runGit(peer, ["config", "user.name", "Cleanup Test"]);
          yield* runGit(peer, ["config", "user.email", "cleanup@example.com"]);
          yield* fileSystem.writeFileString(path.join(peer, "remote.txt"), "remote advance\n");
          yield* runGit(peer, ["add", "."]);
          yield* runGit(peer, ["commit", "-m", "remote advance"]);
          yield* runGit(peer, ["push", "origin", "main"]);
          if (diverged) {
            yield* fileSystem.writeFileString(path.join(root, "local.txt"), "local advance\n");
            yield* runJj(root, ["commit", "-m", "local advance"]);
            yield* runJj(root, ["bookmark", "move", "main", "--to", "@-", "--allow-backwards"]);
          }
          const before = yield* runJj(root, [
            "bookmark",
            "list",
            "-T",
            'name ++ ":" ++ normal_target.commit_id() ++ "\\n"',
          ]);
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, undefined, true);
          assert.isNull(inspected.reason);
          assert.isTrue(inspected.integrated);
          // A later candidate must use the private refresh, not stale main@origin.
          assert.isTrue((yield* inspectJjStorageCleanup(cwd, bookmark)).integrated);
          assert.equal(
            yield* runJj(root, [
              "bookmark",
              "list",
              "-T",
              'name ++ ":" ++ normal_target.commit_id() ++ "\\n"',
            ]),
            before,
          );
          assert.notEqual(
            (yield* runGit(root, ["rev-parse", "refs/t3/remotes/origin/main"])).trim(),
            localMain,
          );
        }),
      ),
  );

  it.effect.each([
    "tracked edit",
    "tracked deletion",
    "untracked",
    "oversized",
    "ignored",
    "description",
  ] as const)("preserves late %s at the destructive boundary", (lateCase) =>
    withWorkspace(({ cwd, root, fileSystem, path, driver }) =>
      Effect.gen(function* () {
        const keepWhen =
          lateCase === "ignored"
            ? "any-local-files"
            : lateCase === "untracked" || lateCase === "oversized"
              ? "uncommitted-changes"
              : "tracked-changes";
        if (lateCase === "oversized") {
          yield* runJj(cwd, ["config", "set", "--repo", "snapshot.max-new-file-size", "1"]);
        }
        if (lateCase === "ignored") {
          yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "late.cache\n");
          yield* runJj(cwd, ["commit", "-m", "ignore cache"]);
          yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        }
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, keepWhen);
        assert.isNull(inspected.reason);
        const before = yield* commitId(cwd, "@");
        const file = lateCase.startsWith("tracked")
          ? "seed.txt"
          : lateCase === "ignored"
            ? "late.cache"
            : "late.txt";
        let injected = false;
        const inject = (directory: string) =>
          Effect.gen(function* () {
            injected = true;
            if (lateCase === "description") {
              yield* runJj(root, [
                "--ignore-working-copy",
                "describe",
                "-r",
                `${workspaceNameForRef(bookmark)}@`,
                "-m",
                "external description",
              ]).pipe(Effect.orDie);
            } else if (lateCase === "tracked deletion") {
              yield* fileSystem.remove(path.join(directory, file));
            } else {
              yield* fileSystem.writeFileString(path.join(directory, file), "late payload\n");
            }
          });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const wrappedSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              !injected &&
              command._tag === "StandardCommand" &&
              command.args.includes("workspace") &&
              command.args.includes("remove")
            ) {
              yield* inject(cwd);
            }
            return yield* spawner.spawn(command);
          }),
        );
        const wrappedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* fileSystem.rename(from, to);
              if (!injected && from === cwd) yield* inject(to);
            }),
        });
        const reason = yield* removeJjStorageCleanup(
          cwd,
          bookmark,
          inspected.commitId,
          keepWhen,
        ).pipe(
          Effect.provide(Layer.empty, { local: true }),
          Effect.provideService(FileSystem.FileSystem, wrappedFs),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrappedSpawner),
        );
        assert.isTrue(injected);
        assert.isNotNull(reason);
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.isTrue((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
        if (lateCase === "description") {
          assert.notEqual(yield* commitId(root, `${workspaceNameForRef(bookmark)}@`), before);
        } else {
          assert.equal(yield* commitId(root, `${workspaceNameForRef(bookmark)}@`), before);
          if (lateCase === "tracked deletion")
            assert.isFalse(yield* fileSystem.exists(path.join(cwd, file)));
          else
            assert.equal(yield* fileSystem.readFileString(path.join(cwd, file)), "late payload\n");
        }
      }),
    ),
  );

  it.effect(
    "preserves held files and a concurrently recreated workspace path on restoration failure",
    () =>
      withWorkspace(({ cwd, fileSystem, path }) =>
        Effect.gen(function* () {
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
          assert.isNull(inspected.reason);
          let held: string | undefined;
          const wrappedFs = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (from, to) =>
              Effect.gen(function* () {
                yield* fileSystem.rename(from, to);
                if (from === cwd && held === undefined) {
                  held = to;
                  yield* fileSystem.writeFileString(
                    path.join(to, "late.txt"),
                    "preserved late work\n",
                  );
                  yield* fileSystem.makeDirectory(cwd);
                  yield* fileSystem.writeFileString(
                    path.join(cwd, "concurrent.txt"),
                    "concurrent work\n",
                  );
                }
              }),
          });
          const result = yield* Effect.flip(
            removeJjStorageCleanup(cwd, bookmark, inspected.commitId).pipe(
              Effect.provide(Layer.empty, { local: true }),
              Effect.provideService(FileSystem.FileSystem, wrappedFs),
            ),
          );
          assert.include(result.message, `recover preserved files from ${held}`);
          assert.isDefined(held);
          assert.equal(
            yield* fileSystem.readFileString(path.join(held!, "late.txt")),
            "preserved late work\n",
          );
          assert.equal(
            yield* fileSystem.readFileString(path.join(cwd, "concurrent.txt")),
            "concurrent work\n",
          );
        }),
      ),
  );
  it.effect("reports a preserved holding path when forget committed but its process failed", () =>
    withWorkspace(({ cwd, root, fileSystem, path, driver }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
        yield* runJj(cwd, ["commit", "-m", "ignore generated file"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        yield* runJj(cwd, ["config", "set", "--repo", "snapshot.auto-track", "none()"]);
        yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "keep\n");
        yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "keep\n");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, "tracked-changes");
        assert.isNull(inspected.reason);
        let held: string | undefined;
        const wrappedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            fileSystem.rename(from, to).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (from === cwd) held = to;
                }),
              ),
            ),
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const wrappedSpawner = ChildProcessSpawner.make((command) =>
          spawner.spawn(command).pipe(
            Effect.map((child) =>
              command._tag === "StandardCommand" &&
              command.args.includes("workspace") &&
              command.args.includes("forget")
                ? {
                    ...child,
                    exitCode: child.exitCode.pipe(
                      Effect.map(() => ChildProcessSpawner.ExitCode(1)),
                    ),
                  }
                : child,
            ),
          ),
        );
        const error = yield* Effect.flip(
          removeJjStorageCleanup(cwd, bookmark, inspected.commitId, "tracked-changes").pipe(
            Effect.provide(Layer.empty, { local: true }),
            Effect.provideService(FileSystem.FileSystem, wrappedFs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrappedSpawner),
          ),
        );
        assert.include(error.message, `recover preserved files from ${held}`);
        assert.isDefined(held);
        assert.isTrue(yield* fileSystem.exists(held!));
        assert.equal(yield* fileSystem.readFileString(path.join(held!, "untracked.txt")), "keep\n");
        assert.equal(yield* fileSystem.readFileString(path.join(held!, "ignored.txt")), "keep\n");
        assert.equal(yield* fileSystem.readFileString(path.join(held!, "seed.txt")), "seed\n");
        assert.isFalse(yield* fileSystem.exists(cwd));
        assert.isFalse((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
      }),
    ),
  );

  it.live.each(["prune", "remove"] as const)(
    "serializes repo-wide %s against a cleanup hold",
    (action) =>
      withWorkspace((repo) =>
        Effect.gen(function* () {
          const { cwd, root, fileSystem, path, driver, process } = repo;
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
          const moved = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const wrappedFs = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (from, to) =>
              Effect.gen(function* () {
                yield* fileSystem.rename(from, to);
                if (from === cwd) {
                  yield* fileSystem.writeFileString(path.join(to, "late.txt"), "keep\n");
                  yield* Deferred.succeed(moved, undefined);
                  yield* Deferred.await(release);
                }
              }),
          });
          const removing = yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId).pipe(
            Effect.provide(Layer.empty, { local: true }),
            Effect.provideService(FileSystem.FileSystem, wrappedFs),
            Effect.forkChild,
          );
          yield* Deferred.await(moved);
          const lockAttempted = yield* Deferred.make<void>();
          const originalWithPermit = workspacePruneLock.withPermit;
          using _permitSpy = vi
            .spyOn(workspacePruneLock, "withPermit")
            .mockImplementation(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const acquired = yield* workspacePruneLock.takeIfAvailable(1);
                if (acquired) yield* workspacePruneLock.release(1);
                assert.isFalse(acquired);
                yield* Deferred.succeed(lockAttempted, undefined);
                return yield* originalWithPermit(effect);
              }),
            );
          const ops = makeJjWorkspaces({
            driver,
            process,
            fileSystem,
            path,
            worktreesDir: repo.base,
            bookmarkTo: makeJjRemotes({ driver, process }).bookmarkTo,
          });
          let pruned = false;
          const pruning = yield* (
            action === "prune"
              ? ops.pruneWorktrees({ cwd: root })
              : ops.removeWorktree({ cwd: root, path: path.join(repo.base, "missing-sibling") })
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                pruned = true;
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(lockAttempted);
          assert.isFalse(pruned);
          yield* Deferred.succeed(release, undefined);
          const reason = yield* Fiber.join(removing);
          yield* Fiber.join(pruning);
          assert.isNotNull(reason);
          assert.isTrue(pruned);
          assert.isTrue((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
          assert.equal(yield* fileSystem.readFileString(path.join(cwd, "late.txt")), "keep\n");
          assert.isNotEmpty(yield* runGit(cwd, ["rev-parse", "--git-dir"]));
        }).pipe(Effect.scoped),
      ),
  );

  it.effect("restores a real workspace when interrupted immediately after rename", () =>
    withWorkspace(({ cwd, fileSystem, driver, root }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        const moved = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const wrappedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* fileSystem.rename(from, to);
              if (from === cwd) {
                yield* Deferred.succeed(moved, undefined);
                yield* Deferred.await(release);
              }
            }),
        });
        const removing = yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId).pipe(
          Effect.provide(Layer.empty, { local: true }),
          Effect.provideService(FileSystem.FileSystem, wrappedFs),
          Effect.forkChild,
        );
        yield* Deferred.await(moved);
        const interrupting = yield* Fiber.interrupt(removing).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.isTrue((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
        assert.isNotEmpty(yield* runGit(cwd, ["rev-parse", "--git-dir"]));
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("does not snapshot untracked main-workspace files during removal", () =>
    withWorkspace(({ cwd, root, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["config", "set", "--repo", "snapshot.auto-track", "none()"]);
        yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "main-only secret");
        const before = yield* commitId(root, "@");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.equal(yield* commitId(root, "@"), before);
        assert.notInclude(
          yield* runJj(root, ["--ignore-working-copy", "file", "list"]),
          "secret.txt",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(root, "secret.txt")),
          "main-only secret",
        );
      }),
    ),
  );

  it.effect("keeps ignored target files even when the main Git index tracks their path", () =>
    withWorkspace(({ cwd, root, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runGit(root, ["add", "seed.txt"]);
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "seed.txt\n");
        yield* runJj(cwd, ["file", "untrack", "seed.txt"]);
        yield* runJj(cwd, ["commit", "-m", "stop tracking seed"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        assert.include(
          (yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason!,
          "has ignored files (seed.txt)",
        );
        assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark)).reason);
      }),
    ),
  );

  it.effect("keeps a dirty working-copy commit", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, "seed.txt"), "agent changes\n");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNotNull(inspected.reason);
        assert.isNotNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "seed.txt")),
          "agent changes\n",
        );
      }),
    ),
  );

  it.effect("preserves untracked and ignored files until forgetting the held workspace", () =>
    withWorkspace(({ cwd, root, fileSystem, path, driver }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
        yield* runJj(cwd, ["commit", "-m", "ignore generated file"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        yield* runJj(cwd, ["config", "set", "--repo", "snapshot.auto-track", "none()"]);
        yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "discard\n");
        yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "discard\n");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, "tracked-changes");
        assert.isNull(inspected.reason);
        let held: string | undefined;
        const wrappedFs = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            fileSystem.rename(from, to).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (from === cwd) held = to;
                }),
              ),
            ),
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        let checked = false;
        const wrappedSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              command._tag === "StandardCommand" &&
              command.command === "jj" &&
              command.args.includes("forget")
            ) {
              assert.isDefined(held);
              assert.equal(
                yield* fileSystem.readFileString(path.join(held!, "untracked.txt")),
                "discard\n",
              );
              assert.equal(
                yield* fileSystem.readFileString(path.join(held!, "ignored.txt")),
                "discard\n",
              );
              assert.equal(
                yield* fileSystem.readFileString(path.join(held!, "seed.txt")),
                "seed\n",
              );
              checked = true;
            }
            return yield* spawner.spawn(command);
          }),
        );
        assert.isNull(
          yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId, "tracked-changes").pipe(
            Effect.provide(Layer.empty, { local: true }),
            Effect.provideService(FileSystem.FileSystem, wrappedFs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrappedSpawner),
          ),
        );
        assert.isTrue(checked);
        assert.isFalse(yield* fileSystem.exists(held!));
        assert.isFalse(yield* fileSystem.exists(cwd));
        assert.isFalse((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
      }),
    ),
  );
  it.effect.each(["tracked edit", "description"] as const)(
    "preserves local files when a late %s refuses removal",
    (lateCase) =>
      withWorkspace(({ cwd, root, fileSystem, path }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
          yield* runJj(cwd, ["commit", "-m", "ignore generated file"]);
          yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
          yield* runJj(cwd, ["config", "set", "--repo", "snapshot.auto-track", "none()"]);
          yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "keep\n");
          yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "keep\n");
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, "tracked-changes");
          assert.isNull(inspected.reason);
          let injected = false;
          const wrappedFs = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (from, to) =>
              fileSystem.rename(from, to).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (from !== cwd) return;
                    injected = true;
                    if (lateCase === "tracked edit") {
                      yield* fileSystem.writeFileString(
                        path.join(to, "seed.txt"),
                        "late tracked edit\n",
                      );
                    } else {
                      yield* runJj(root, [
                        "--ignore-working-copy",
                        "describe",
                        "-r",
                        `${workspaceNameForRef(bookmark)}@`,
                        "-m",
                        "late description",
                      ]).pipe(Effect.orDie);
                    }
                  }),
                ),
              ),
          });
          const reason = yield* removeJjStorageCleanup(
            cwd,
            bookmark,
            inspected.commitId,
            "tracked-changes",
          ).pipe(
            Effect.provide(Layer.empty, { local: true }),
            Effect.provideService(FileSystem.FileSystem, wrappedFs),
          );
          assert.isTrue(injected);
          assert.isNotNull(reason);
          assert.isTrue(yield* fileSystem.exists(cwd));
          assert.equal(yield* fileSystem.readFileString(path.join(cwd, "untracked.txt")), "keep\n");
          assert.equal(yield* fileSystem.readFileString(path.join(cwd, "ignored.txt")), "keep\n");
          if (lateCase === "tracked edit") {
            assert.equal(
              yield* fileSystem.readFileString(path.join(cwd, "seed.txt")),
              "late tracked edit\n",
            );
          } else {
            assert.include(
              yield* runJj(root, [
                "--ignore-working-copy",
                "log",
                "--no-graph",
                "-r",
                `${workspaceNameForRef(bookmark)}@`,
                "-T",
                "description",
              ]),
              "late description",
            );
          }
        }),
      ),
  );

  it.effect("keeps oversized untracked files that jj refuses to snapshot", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runJj(cwd, ["config", "set", "--repo", "snapshot.max-new-file-size", "1"]);
        yield* fileSystem.writeFileString(
          path.join(cwd, "oversized.txt"),
          "too large to snapshot\n",
        );
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, "uncommitted-changes");
        assert.isNotNull(inspected.reason);
        assert.isTrue(yield* fileSystem.exists(path.join(cwd, "oversized.txt")));
      }),
    ),
  );

  it.effect("keeps nonempty ancestors stranded behind an empty working copy", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, "stranded.txt"), "unbookmarked commit\n");
        yield* runJj(cwd, ["commit", "-m", "stranded work"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.equal(inspected.reason, "has commits not reachable from any bookmark");
        assert.isNotNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isTrue(yield* fileSystem.exists(cwd));
      }),
    ),
  );

  it.effect("keeps empty ancestors that no bookmark protects", () =>
    withWorkspace(({ cwd }) =>
      Effect.gen(function* () {
        yield* runJj(cwd, ["new"]);
        assert.equal(
          (yield* inspectJjStorageCleanup(cwd, bookmark)).reason,
          "has commits not reachable from any bookmark",
        );
      }),
    ),
  );

  it.effect("allows ancestry protected only by a remote bookmark", () =>
    withWorkspace(({ cwd, root, remotePath, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(remotePath);
        yield* runGit(remotePath, ["init", "--bare", "--initial-branch=main"]);
        yield* runJj(root, ["git", "remote", "add", "origin", remotePath]);
        yield* fileSystem.writeFileString(path.join(cwd, "remote-work.txt"), "published work\n");
        yield* runJj(cwd, ["commit", "-m", "published work"]);
        yield* runJj(cwd, ["bookmark", "create", "published", "-r", "@-"]);
        yield* runJj(cwd, ["git", "push", "--bookmark", "published", "--remote", "origin"]);
        yield* runJj(cwd, ["bookmark", "delete", "published"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
      }),
    ),
  );

  it.effect("allows bookmarked commits not integrated into main", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, "protected.txt"), "bookmarked work\n");
        yield* runJj(cwd, ["commit", "-m", "protected work"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.isFalse(inspected.integrated);
      }),
    ),
  );

  it.effect("never removes the main workspace", () =>
    withWorkspace(({ root, fileSystem }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(root, "main");
        assert.equal(inspected.reason, "is the main Jujutsu workspace");
        assert.isNotNull(yield* removeJjStorageCleanup(root, "main", inspected.commitId));
        assert.isTrue(yield* fileSystem.exists(root));
      }),
    ),
  );

  it.effect("refuses a different managed bookmark", () =>
    withWorkspace(({ cwd }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, "other-bookmark");
        assert.equal(inspected.reason, "workspace no longer belongs to the expected bookmark");
      }),
    ),
  );

  it.effect("rechecks files written after inspection", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        yield* fileSystem.writeFileString(path.join(cwd, "late.txt"), "late work\n");
        assert.isNotNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isTrue(yield* fileSystem.exists(path.join(cwd, "late.txt")));
      }),
    ),
  );

  it.effect("rechecks an otherwise clean bookmarked parent changed after inspection", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        yield* fileSystem.writeFileString(path.join(cwd, "committed.txt"), "new head\n");
        yield* runJj(cwd, ["commit", "-m", "new bookmarked head"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        assert.equal(
          yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId),
          "workspace changed since inspection",
        );
        assert.isTrue(yield* fileSystem.exists(cwd));
      }),
    ),
  );

  it.effect(
    "ignores empty directories and keeps ignored-only directories only for any-local-files",
    () =>
      withWorkspace(({ cwd, fileSystem, path }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "*.cache\n");
          yield* runJj(cwd, ["commit", "-m", "ignore cache files"]);
          yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
          yield* fileSystem.makeDirectory(path.join(cwd, "emptydir"));
          assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason);
          yield* fileSystem.makeDirectory(path.join(cwd, "onlyignored", "nested"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(cwd, "onlyignored", "nested", "data.cache"),
            "local cache data",
          );
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
          assert.isNull(inspected.reason);
          assert.include(
            (yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason!,
            "has ignored files",
          );
          assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
          assert.isFalse(yield* fileSystem.exists(cwd));
        }),
      ),
  );

  it.effect("keeps ignored files only for any-local-files, except node_modules", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "cache/\nnode_modules/\n");
        yield* runJj(cwd, ["commit", "-m", "ignore generated files"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        yield* fileSystem.makeDirectory(path.join(cwd, "node_modules"));
        yield* fileSystem.writeFileString(
          path.join(cwd, "node_modules", "dependency"),
          "generated",
        );
        assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason);
        yield* fileSystem.makeDirectory(path.join(cwd, "cache"));
        yield* fileSystem.writeFileString(path.join(cwd, "cache", "precious"), "local data");
        assert.include(
          (yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason!,
          "has ignored files",
        );
        assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark)).reason);
      }),
    ),
  );
});
