import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import { workspaceNameForRef } from "./jj/JjWorkspaces.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import type { runJj } from "./vcs/testing/JjTestSupport.ts";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  type ServerSettings,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
const encodeSessionPayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));


export const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
export const DAY_MS = 24 * 60 * 60 * 1_000;

export function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

export function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

export const allocatedBytes = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((stat) =>
      Option.getOrElse(
        Option.map(stat.blocks, (blocks) => Number(blocks) * 512),
        () => Number(stat.size),
      ),
    ),
  );

export const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
  options?: { readonly runJj?: typeof runJj; readonly sqlOverride?: SqlClient.SqlClient },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" }));
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = `${config.worktreesDir}/feature`;
    if (options?.runJj) {
      yield* options.runJj(repo, ["git", "init", "--colocate"]);
      yield* options.runJj(repo, ["bookmark", "create", "feature", "-r", "main"]);
      yield* options.runJj(repo, [
        "workspace",
        "add",
        "--colocate",
        "--name",
        workspaceNameForRef("feature"),
        "-m",
        "t3:feature",
        "-r",
        "feature",
        worktree,
      ]);
    } else {
      yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    }
    let settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let deletedThreads: OrchestrationV2ThreadShell[] = [];
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let sessionLiveChecks = 0;
    let onLiveCheck: Effect.Effect<void> = Effect.void;
    let outboxStatus: string | null = null;
    let scheduledThreadIds: string[] = [];
    let fullStatusCalls = 0;
    let statusCommands = 0;
    let gitInspections = 0;
    let snapshotReads = 0;
    let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    let taskFolders: Pick<TaskFolders.TaskFolders["Service"], "find" | "remove"> = {
      find: () => Effect.succeed(null),
      remove: () => Effect.succeed({ removed: [], kept: [] }),
    };
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            gitInspections++;
            if (input.args[0] === "status") statusCommands++;
            // Before Git's own clean check: inside `git worktree remove`, or on
            // Windows the same status check the removal makes before deleting.
            if (
              editBeforeRemoval &&
              (input.args.includes("remove") || input.args.includes("--porcelain"))
            )
              yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
            return yield* git.execute(input);
          }),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot }))),
        listShells: () =>
          Effect.sync(() =>
            projectRoots.map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-${index + 1}`),
              workspaceRoot,
            })),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            const visible = threads.filter((thread) => thread.deletedAt === null);
            return {
              threads:
                input?.location === "archive"
                  ? []
                  : visible.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                input?.location === "active"
                  ? []
                  : visible.filter((thread) => thread.archivedAt !== null),
            };
          }),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        getShellSnapshot: (input?: { threadIds?: ReadonlyArray<ThreadId> }) =>
          Effect.sync(() => ({
            threads: threads.filter((thread) => input?.threadIds?.includes(thread.id) ?? true),
            archivedThreads: [],
          })),
        dispatch: (command: OrchestrationV2ServerCommand) =>
          Effect.sync(() => {
            if (command.type === "thread.metadata.update" && command.branch != null) {
              const branch = command.branch;
              threads = threads.map((thread) =>
                thread.id === command.threadId && thread.branch === command.expectedBranch
                  ? { ...thread, branch }
                  : thread,
              );
            }
            return { sequence: 0, storedEvents: [] };
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(GitWorkflowService.GitWorkflowService, {
        currentBranch: (cwd: string) =>
          command(cwd, ["branch", "--show-current"]).pipe(
            Effect.map((result) => result.stdout.trim() || null),
          ),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () =>
          Effect.sync(() => {
            sessionLiveChecks++;
            return sessionLive;
          }).pipe(Effect.tap(() => Effect.suspend(() => onLiveCheck))),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(
        SqlClient.SqlClient,
        options?.sqlOverride ??
          (((strings: TemplateStringsArray) =>
            Effect.sync(() =>
              strings.join("").includes("retained_checkpoint_threads")
                ? []
                : openSessionCwd !== null &&
                    strings.join("").includes("projection_provider_sessions")
                  ? [
                      {
                        payload_json: encodeSessionPayload({
                          id: "session-1",
                          driver: "codex",
                          providerInstanceId: "codex",
                          status: "ready",
                          cwd: openSessionCwd,
                          model: null,
                          capabilities: CodexProviderCapabilitiesV2,
                          createdAt: "2026-06-01T12:00:00.000Z",
                          updatedAt: "2026-06-01T12:00:00.000Z",
                          lastError: null,
                        }),
                      },
                    ]
                  : outboxStatus !== null &&
                      strings.join("").includes("orchestration_v2_effect_outbox")
                    ? [{ status: outboxStatus }]
                    : strings.join("").includes("deleted_at IS NOT NULL")
                      ? deletedThreads.map((thread) => ({
                          payload_json: JSON.stringify(thread),
                          workspaceRoot: repo,
                        }))
                      : strings.join("").includes('AS "worktreePath"')
                        ? [
                            ...threads.flatMap((thread) => thread.worktreePath ?? []),
                            ...storedWorktreePaths,
                          ].map((worktreePath) => ({ worktreePath }))
                        : strings.join("").includes("scheduled_tasks")
                          ? scheduledThreadIds.map((threadId) => ({ threadId }))
                          : [],
            )) as unknown as SqlClient.SqlClient),
      ),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: (
          listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
        ) =>
          Effect.sync(() => {
            terminalListener = listener;
            return () => {};
          }),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
      Effect.provideService(TaskFolders.TaskFolders, {
        find: (target: string) => taskFolders.find(target),
        remove: (input: Parameters<TaskFolders.TaskFolders["Service"]["remove"]>[0]) =>
          taskFolders.remove(input),
      } as unknown as TaskFolders.TaskFolders["Service"]),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      setTaskFolders: (service: typeof taskFolders) => {
        taskFolders = service;
      },
      setTerminals: (terminals: TerminalSummary[]) =>
        terminalListener?.({ type: "snapshot", terminals }) ?? Effect.void,
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      fs,
      worktree,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      threadBranches: () => threads.map((thread) => thread.branch),
      setOnLiveCheck: (hook: Effect.Effect<void>) => {
        onLiveCheck = hook;
      },
      setOutboxStatus: (status: string | null) => {
        outboxStatus = status;
      },
      setScheduledThreadIds: (next: string[]) => {
        scheduledThreadIds = next;
      },
      setDeletedThreads: (next: OrchestrationV2ThreadShell[]) => {
        deletedThreads = next;
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
      },
      setProjectRoots: (roots: string[]) => {
        projectRoots = roots;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      openTerminal: (paths: { cwd: string; worktreePath: string | null }) =>
        terminalListener?.({
          type: "upsert",
          terminal: {
            threadId: "thread-1",
            terminalId: "terminal-1",
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: "2026-06-10T12:00:00.000Z",
            ...paths,
          },
        }) ?? Effect.void,
      gitInspections: () => gitInspections,
      fullStatusCalls: () => fullStatusCalls,
      statusCommands: () => statusCommands,
      snapshotReads: () => snapshotReads,
      sessionLiveChecks: () => sessionLiveChecks,
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
export const pausedMeasurementFixture = (storageCleanup?: StorageCleanupSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
  });
export const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
export const annexWorktree = Effect.fnUntraced(function* (
  fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
  worktree: string,
) {
  const adminDir = (yield* fixture.command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout;
  yield* fixture.fs.remove(`${worktree}/.git`);
  yield* fixture.fs.symlink(adminDir.trim(), `${worktree}/.git`);
});

export const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Digest.Digest
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer));


it.live.each(["repository", "uppercase", "bare"] as const)(
  "keeps a worktree holding an ignored nested %s",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const nested = `${worktree}/dist/nested`;
        if (kind === "uppercase") {
          yield* command(repo, ["worktree", "add", "-b", "nested", nested]);
        } else {
          yield* command(repo, [
            "clone",
            "--no-hardlinks",
            ...(kind === "bare" ? ["--bare"] : []),
            repo,
            nested,
          ]);
        }
        if (kind === "uppercase") yield* fs.rename(`${nested}/.git`, `${nested}/.GIT`);
        yield* fs.writeFileString(`${nested}/uncommitted.txt`, "irreplaceable work\n");
        expect((yield* command(worktree, ["status", "--porcelain"])).stdout).toBe("");
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
          outcome: "kept",
          reason: "Contains a nested Git repository",
        });
        expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("irreplaceable work\n");
        expect(
          (yield* command(nested, [
            ...(kind === "uppercase"
              ? [
                  `--git-dir=${(yield* fs.readFileString(`${nested}/.GIT`)).trim().slice(8)}`,
                  "--work-tree=.",
                ]
              : []),
            "-c",
            "safe.bareRepository=all",
            "rev-parse",
            "--is-bare-repository",
          ])).stdout.trim(),
        ).toBe(String(kind === "bare"));
      }),
    ),
);

export const submoduleCleanupFixture = () =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture();
    const { command, repo, worktree } = fixture;
    const submodule = `${worktree}/module`;
    const child = `${submodule}/child`;
    for (const [cwd, name] of [
      [worktree, "module"],
      [submodule, "child"],
    ] as const) {
      yield* command(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", repo, name]);
      yield* command(`${cwd}/${name}`, ["config", "user.name", "Cleanup test"]);
      yield* command(`${cwd}/${name}`, ["config", "user.email", "cleanup@example.test"]);
    }
    const recordSubmodules = () =>
      Effect.gen(function* () {
        yield* command(submodule, ["commit", "-am", "record child"]);
        yield* command(submodule, ["push", "origin", "HEAD:submodule"]);
        yield* command(worktree, ["commit", "-am", "record module"]);
      });
    yield* recordSubmodules();
    return { ...fixture, submodule, child, recordSubmodules };
  });

it.live("inspects a pnpm store excluded from reclaimed bytes for nested repositories", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
      setPolicy("tracked-changes");
      const storeDir = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-store-" });
      const nested = `${worktree}/node_modules/.pnpm/nested`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, nested]);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
      yield* fs.writeFileString(
        `${worktree}/node_modules/.modules.yaml`,
        JSON.stringify({ storeDir, virtualStoreDir: ".pnpm" }),
      );
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
    }),
  ),
);

it.live("keeps an ignored repository inside a registered submodule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      const nested = `${submodule}/dist/nested`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, nested]);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
    }),
  ),
);

it.live("removes clean submodules recursively, including deinitialized repositories", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      let editedDuringClean = false;
      const { service, repo, worktree, submodule, command, recordSubmodules, setPolicy } =
        yield* submoduleCleanupFixture().pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, {
            ...git,
            execute: (input) =>
              git.execute(input).pipe(
                Effect.tap(() => {
                  if (input.args[0] !== "clean") return Effect.void;
                  editedDuringClean = true;
                  return fs.writeFileString(`${input.cwd}/tracked.txt`, "late edit\n");
                }),
              ),
          }),
        );
      setPolicy("tracked-changes");
      yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
      yield* fs.writeFileString(`${worktree}/.env`, "ignored\n");
      yield* command(submodule, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "stored",
      ]);
      const legacy = `${worktree}/legacy`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, legacy]);
      yield* command(worktree, ["submodule", "add", repo, "legacy"]);
      expect((yield* fs.stat(`${legacy}/.git`)).type).toBe("Directory");
      yield* command(legacy, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "child",
      ]);
      yield* command(legacy, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "stored",
      ]);
      yield* command(legacy, [
        "-c",
        "user.name=Cleanup test",
        "-c",
        "user.email=cleanup@example.test",
        "commit",
        "-am",
        "record legacy children",
      ]);
      yield* command(legacy, ["push", "origin", "HEAD:legacy"]);
      yield* command(legacy, ["submodule", "deinit", "stored"]);
      yield* recordSubmodules();
      yield* command(submodule, ["submodule", "deinit", "stored"]);
      const checkpoint = (yield* command(submodule, [
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "checkpoint",
      ])).stdout.trim();
      yield* command(submodule, [
        "update-ref",
        "refs/t3/orchestration-v2/checkpoints/test",
        checkpoint,
      ]);
      const admin = (yield* command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      const report = yield* service.runNow;
      expect(editedDuringClean).toBe(false);
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "removed",
      });
      expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
      expect(yield* fs.exists(worktree)).toBe(false);
      expect(yield* fs.exists(admin)).toBe(false);
    }),
  ),
);

it.live("keeps nested submodule files protected by the current keep rule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      yield* fs.writeFileString(`${child}/tracked.txt`, "local edit\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("local edit\n");
      yield* fs.writeFileString(`${child}/tracked.txt`, "original\n");
      setPolicy("any-local-files");
      yield* fs.writeFileString(`${child}/.env`, "local secret\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/.env`)).toBe("local secret\n");

      yield* fs.remove(`${child}/.env`);
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${child}/.env`, "secret after deinit\n");
      const report = yield* service.runNow;
      expect({
        outcome: report.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/.env`))
          ? yield* fs.readFileString(`${child}/.env`)
          : null,
      }).toEqual({ outcome: "kept", contents: "secret after deinit\n" });

      yield* fs.remove(`${child}/.env`);
      setPolicy("uncommitted-changes");
      yield* fs.writeFileString(`${child}/notes.txt`, "notes after deinit\n");
      const untrackedReport = yield* service.runNow;
      expect({
        outcome: untrackedReport.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/notes.txt`))
          ? yield* fs.readFileString(`${child}/notes.txt`)
          : null,
      }).toEqual({ outcome: "kept", contents: "notes after deinit\n" });
    }),
  ),
);

it.live("keeps unpushed submodule history after checkout and deinitialization", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(child, ["checkout", "-b", "local-only"]);
      yield* fs.writeFileString(`${child}/tracked.txt`, "unpublished work\n");
      yield* command(child, ["commit", "-am", "local work"]);
      const local = (yield* command(child, ["rev-parse", "HEAD"])).stdout.trim();
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("unpublished work\n");

      yield* command(child, ["checkout", "main"]);
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, [
          "--git-dir",
          childGit,
          "rev-parse",
          "refs/heads/local-only",
        ])).stdout.trim(),
      ).toBe(local);
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", "local-only:tracked.txt"]))
          .stdout,
      ).toBe("unpublished work\n");
      yield* command(worktree, ["--git-dir", childGit, "branch", "-D", "local-only"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", `${local}:tracked.txt`])).stdout,
      ).toBe("unpublished work\n");
    }),
  ),
);

it.live("keeps submodules when stored repository metadata is malformed", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${childGit}/HEAD`, "not a ref\n");
      yield* fs.writeFileString(`${worktree}/notes.txt`, "keep while the worktree stays\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("inspected") });
      expect(yield* fs.exists(worktree)).toBe(true);
      expect(yield* fs.readFileString(`${childGit}/HEAD`)).toBe("not a ref\n");
      expect(yield* fs.readFileString(`${worktree}/notes.txt`)).toBe(
        "keep while the worktree stays\n",
      );
    }),
  ),
);

it.live("preserves late tracked edits when submodules were never initialized", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const { service, fs, worktree, command } = fixture;
      const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(
        `${worktree}/.gitmodules`,
        '[submodule "module"]\n\tpath = module\n\turl = /unused\n',
      );
      yield* command(worktree, ["add", ".gitmodules"]);
      yield* command(worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
      yield* command(worktree, ["commit", "-m", "record uninitialized module"]);
      yield* fs.makeDirectory(`${worktree}/module`);
      fixture.editBeforeRemoval();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "failed" });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("late edit\n");
    }),
  ),
);

