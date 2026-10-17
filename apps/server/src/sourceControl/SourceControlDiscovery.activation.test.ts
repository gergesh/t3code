import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

it.effect("reports implemented tools separately from locally available executables", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) =>
      input.command === "git"
        ? Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "git version 2.51.0\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          })
        : Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: new Error(`${input.command} not found`),
            }),
          ),
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layerTest = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: (kind) => {
          assert.equal(kind, "jj");
          return Effect.succeed({} as VcsDriver.VcsDriver["Service"]);
        },
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        discover: Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;
    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: true, status: "missing" },
      ],
    );
  }).pipe(Effect.provide(layerTest));
});
