import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind, SourceControlRepositoryError } from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as JjWorkflow from "../jj/JjWorkflow.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import { describeJj, JJ_VERSION, runGit, runJj, withJjRepo } from "../vcs/testing/JjTestSupport.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

describeJj("public Jujutsu repository publishing", () => {
  it.effect.each([false, true])(
    `refuses unsupported real jj publishing before allocating a hosted repository (unreadable pointer=%s, jj ${JJ_VERSION})`,
    (unreadablePointer) =>
      withJjRepo({ prefix: "t3-jj-unsupported-publish-", colocated: unreadablePointer }, (repo) =>
        Effect.gen(function* () {
          const operationBefore = yield* runJj(repo.root, [
            "--ignore-working-copy",
            "op",
            "log",
            "--limit",
            "1",
            "--no-graph",
            "-T",
            "id",
          ]);
          const remotesBefore = yield* runJj(repo.root, ["git", "remote", "list"]);
          const pointer = repo.path.join(repo.root, ".jj", "repo");
          const held = repo.path.join(repo.root, ".jj", "repo-held");
          const expectedReason = unreadablePointer
            ? "Could not read the Jujutsu workspace repository pointer."
            : "jj git colocation enable";
          if (unreadablePointer) {
            yield* repo.fileSystem.rename(pointer, held);
            yield* repo.fileSystem.symlink("repo", pointer);
          }
          let created = 0;
          const provider = yield* SourceControlProvider.SourceControlProvider.pipe(
            Effect.provide(
              Layer.mock(SourceControlProvider.SourceControlProvider)({
                kind: SourceControlProviderKind.make("github"),
                createRepository: () =>
                  Effect.sync(() => {
                    created += 1;
                    return {
                      nameWithOwner: "octocat/t3code",
                      url: "https://github.com/octocat/t3code",
                      sshUrl: repo.remotePath,
                    };
                  }),
              }),
            ),
          );
          const infrastructure = Layer.mergeAll(
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              get: () => Effect.succeed(provider),
              resolveLink: () => undefined,
            }),
            NodeCrypto.layer,
            ServerSettings.layerTest(),
            ServerConfig.layerTest(repo.root, repo.path.join(repo.base, "config")),
            Layer.succeed(HostProcess.HomeDirectory, repo.base),
            Layer.succeed(HostProcess.Environment, {}),
            Layer.mock(GitManager.GitManager)({}),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.mock(TextGeneration.TextGeneration)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.succeed(JjVcsDriver.JjVcsDriver, repo.driver),
            Layer.succeed(VcsProcess.VcsProcess, repo.process),
          ).pipe(Layer.provideMerge(NodeServices.layer));
          const git = GitVcsDriver.layer.pipe(Layer.provideMerge(infrastructure));
          const registry = VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProjectConfig.layer),
            Layer.provideMerge(git),
          );
          const { service, workflow } = yield* Effect.all({
            service: SourceControlRepositoryService.make,
            workflow: JjWorkflow.JjWorkflow,
          }).pipe(Effect.provide(JjWorkflow.layer.pipe(Layer.provideMerge(registry))));
          const localStatus = yield* workflow.localStatus({ cwd: repo.root });
          const status = yield* workflow.status({ cwd: repo.root });
          const reason =
            localStatus.vcs?.kind === "jj" ? localStatus.vcs.unsupportedReason : undefined;
          assert.include(reason, expectedReason);
          assert.deepStrictEqual(status.vcs, localStatus.vcs);
          const failure = yield* service
            .publishRepository({
              cwd: repo.root,
              provider: SourceControlProviderKind.make("github"),
              repository: "octocat/t3code",
              visibility: "private",
            })
            .pipe(Effect.flip);
          assert.instanceOf(failure, SourceControlRepositoryError);
          assert.equal(created, 0);
          assert.include(failure.detail, expectedReason);
          if (unreadablePointer) {
            yield* repo.fileSystem.remove(pointer);
            yield* repo.fileSystem.rename(held, pointer);
          }
          assert.equal(yield* runJj(repo.root, ["git", "remote", "list"]), remotesBefore);
          assert.equal(
            yield* runJj(repo.root, [
              "--ignore-working-copy",
              "op",
              "log",
              "--limit",
              "1",
              "--no-graph",
              "-T",
              "id",
            ]),
            operationBefore,
          );
        }),
      ),
  );

  it.effect.each([
    {
      undescribed: false,
      name: "preserves real jj firstpush guidance through the public repository service",
    },
    {
      undescribed: true,
      name: "preserves real jj local preflight guidance through the public repository service",
    },
  ])("$name", ({ undescribed }) =>
    withJjRepo({ prefix: "t3-jj-public-publish-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const remote = repo.path.join(repo.base, "rejected.git");
        yield* runGit(repo.root, ["init", "--bare", remote]);
        yield* runGit(repo.root, ["--git-dir", remote, "config", "core.hooksPath", "hooks"]);
        const hook = repo.path.join(remote, "hooks", "pre-receive");
        yield* repo.fileSystem.writeFileString(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n");
        yield* repo.fileSystem.chmod(hook, 0o755);
        yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "work.txt"), "work\n");
        yield* runJj(repo.root, undescribed ? ["new"] : ["commit", "-m", "Publish work"]);
        const provider = yield* SourceControlProvider.SourceControlProvider.pipe(
          Effect.provide(
            Layer.mock(SourceControlProvider.SourceControlProvider)({
              kind: SourceControlProviderKind.make("github"),
              createRepository: () =>
                Effect.succeed({
                  nameWithOwner: "octocat/t3code",
                  url: "https://github.com/octocat/t3code",
                  sshUrl: remote,
                  httpsUrl: remote,
                }),
            }),
          ),
        );
        const providers = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          get: () => Effect.succeed(provider),
          resolveLink: () => undefined,
        });
        const dependencies = Layer.mergeAll(
          providers,
          NodeCrypto.layer,
          ServerSettings.layerTest(),
          ServerConfig.layerTest(repo.root, repo.path.join(repo.base, "config")),
          Layer.succeed(HostProcess.HomeDirectory, repo.base),
          Layer.succeed(HostProcess.Environment, {}),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(TextGeneration.TextGeneration)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({}),
        );
        const infrastructure = Layer.mergeAll(
          dependencies,
          Layer.succeed(JjVcsDriver.JjVcsDriver, repo.driver),
          Layer.succeed(VcsProcess.VcsProcess, repo.process),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const git = GitVcsDriver.layer.pipe(Layer.provideMerge(infrastructure));
        const registry = VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProjectConfig.layer),
          Layer.provideMerge(git),
        );
        const service = yield* SourceControlRepositoryService.make.pipe(
          Effect.provide(JjWorkflow.layer.pipe(Layer.provideMerge(registry))),
        );
        const failure = yield* service
          .publishRepository({
            cwd: repo.root,
            provider: SourceControlProviderKind.make("github"),
            repository: "octocat/t3code",
            visibility: "private",
            protocol: "ssh",
          })
          .pipe(Effect.flip);
        assert.instanceOf(failure, SourceControlRepositoryError);
        assert.include(
          failure.detail,
          undescribed
            ? "Describe this change before pushing"
            : 'Created octocat/t3code and added it as remote "origin", but the push failed.',
        );
        if (!undescribed) assert.include(failure.detail, "push again");
        assert.notInclude(failure.detail, "The source control operation could not be completed");
        assert.equal(
          (yield* runGit(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"])).trim(),
          "",
        );
      }),
    ),
  );
});
