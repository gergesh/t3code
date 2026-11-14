import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Migrations from "@alchemy.run/sql/Migrations";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  InvalidRelayDatabaseUrlError,
  parseExternalPostgresUrl,
  relayDatabaseMode,
} from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

const RELAY_MIGRATIONS_TABLE = "relay_migrations";

const RelaySchema = Drizzle.Schema("RelaySchema", {
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  dialect: "postgres",
});

// An operator-provided Postgres (such as Neon) replaces the PlanetScale database for forks.
const ExternalDatabaseUrl = Config.Redacted("RELAY_DATABASE_URL").pipe(
  Config.option,
  Config.map(Option.filter((url) => Redacted.value(url).trim().length > 0)),
);

const ExternalPostgresOrigin = Effect.gen(function* () {
  const url = yield* ExternalDatabaseUrl;
  return Option.isNone(url)
    ? Option.none()
    : Option.some(
        yield* Effect.try({
          try: () => parseExternalPostgresUrl(url.value),
          catch: (cause) =>
            Schema.is(InvalidRelayDatabaseUrlError)(cause)
              ? cause
              : new InvalidRelayDatabaseUrlError({ reason: "could not be parsed" }),
        }),
      );
}).pipe(Effect.orDie);

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* RelaySchema;

  const mode = relayDatabaseMode(stage);
  const database =
    mode === "shared-database"
      ? yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
          name: "t3coderelay",
          region: { slug: "us-west" },
          clusterSize: "PS_160",
          migrations: { dir: schema.out, table: RELAY_MIGRATIONS_TABLE },
          replicas: 2,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrations: { dir: schema.out, table: RELAY_MIGRATIONS_TABLE },
        })
      : undefined;

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    ...(branch ? { branch } : {}),
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { branch, database, runtimeRole };
});

const ApplyExternalMigrations = Alchemy.Action(
  "ApplyRelayMigrations",
  Effect.fn(function* (input: {
    readonly dir: string;
    readonly snapshotHash: string;
    readonly migrations: ReadonlyArray<string>;
    readonly host: string;
    readonly database: string;
  }) {
    const url = yield* Config.Redacted("RELAY_DATABASE_URL");
    const run = yield* Migrations.runMigrations({
      input: { dir: input.dir, table: RELAY_MIGRATIONS_TABLE },
      stamped: { table: RELAY_MIGRATIONS_TABLE },
      withExecutor: (apply) =>
        Migrations.withPgExecutor({ connectionString: Redacted.value(url) }, apply),
    });
    return { applied: Object.keys(run.hashes).length };
  }),
);

/** Deploy-time database for the stack: PlanetScale, or the external Postgres with its migrations. */
export const RelayDatabase = Effect.gen(function* () {
  const external = yield* ExternalPostgresOrigin;
  if (Option.isNone(external)) {
    const { branch, database } = yield* PlanetscaleDatabase;
    return { databaseName: database.name, databaseBranchName: branch?.name ?? "main" };
  }
  const schema = yield* RelaySchema;
  yield* ApplyExternalMigrations({
    dir: schema.out,
    snapshotHash: schema.snapshotHash,
    migrations: schema.migrations,
    host: external.value.host,
    database: external.value.database,
  });
  return { databaseName: external.value.database, databaseBranchName: "external" };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const external = yield* ExternalPostgresOrigin;
  const origin = Option.isSome(external)
    ? external.value
    : (yield* PlanetscaleDatabase).runtimeRole.origin;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 40,
  });
});
