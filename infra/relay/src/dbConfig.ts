import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export type RelayDatabaseMode = "shared-database" | "stage-branch";

export function relayDatabaseMode(stage: string): RelayDatabaseMode {
  return stage === "prod" ? "shared-database" : "stage-branch";
}

export interface ExternalPostgresOrigin {
  readonly scheme: "postgres" | "postgresql";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: Redacted.Redacted<string>;
}

export class InvalidRelayDatabaseUrlError extends Schema.TaggedError<InvalidRelayDatabaseUrlError>()(
  "InvalidRelayDatabaseUrlError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `RELAY_DATABASE_URL ${this.reason}`;
  }
}

export function parseExternalPostgresUrl(url: Redacted.Redacted<string>): ExternalPostgresOrigin {
  let parsed: URL;
  try {
    parsed = new URL(Redacted.value(url));
  } catch {
    throw new InvalidRelayDatabaseUrlError({ reason: "is not a valid URL" });
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme !== "postgres" && scheme !== "postgresql") {
    throw new InvalidRelayDatabaseUrlError({ reason: "must be a postgres:// URL" });
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!parsed.hostname || !database || !user || !password) {
    throw new InvalidRelayDatabaseUrlError({
      reason: "must include a user, password, host, and database",
    });
  }
  return {
    scheme,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database,
    user,
    password: Redacted.make(password),
  };
}
