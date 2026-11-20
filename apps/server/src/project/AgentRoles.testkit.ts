import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentRoles from "./AgentRoles.ts";

/** A checkout with no `.agents/roles` folder, for tests that never read role files. */
export const layerNone = Layer.succeed(
  AgentRoles.AgentRoles,
  AgentRoles.AgentRoles.of({
    list: () => Effect.succeed({ roles: [], problems: [] }),
    get: () => Effect.undefined,
  }),
);
