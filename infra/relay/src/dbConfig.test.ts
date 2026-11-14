import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { parseExternalPostgresUrl } from "./dbConfig.ts";

describe("parseExternalPostgresUrl", () => {
  it("splits a Neon connection string into a Hyperdrive origin", () => {
    const origin = parseExternalPostgresUrl(
      Redacted.make(
        "postgresql://relay_owner:p%40ss%2Fw0rd@ep-cool-name-123456.us-west-2.aws.neon.tech/t3coderelay?sslmode=require",
      ),
    );
    expect({ ...origin, password: Redacted.value(origin.password) }).toEqual({
      scheme: "postgresql",
      host: "ep-cool-name-123456.us-west-2.aws.neon.tech",
      port: 5432,
      database: "t3coderelay",
      user: "relay_owner",
      password: "p@ss/w0rd",
    });
  });

  it("keeps an explicit port", () => {
    expect(
      parseExternalPostgresUrl(Redacted.make("postgres://u:p@db.example.com:6543/relay")).port,
    ).toBe(6543);
  });

  it.each([
    ["not a URL", "nope"],
    ["another scheme", "mysql://u:p@db.example.com/relay"],
    ["no database", "postgres://u:p@db.example.com/"],
    ["no password", "postgres://u@db.example.com/relay"],
  ])("rejects %s", (_name, url) => {
    expect(() => parseExternalPostgresUrl(Redacted.make(url))).toThrow(/RELAY_DATABASE_URL/);
  });
});
