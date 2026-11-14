import * as Effect from "effect/Effect";
import type { runTui as RunTui } from "@t3tools/tui";

// Stands in for @t3tools/tui in the standalone executable, which resolves only Node built-ins
// while OpenTUI loads its renderer library from its package folder.
export const runTui: typeof RunTui = () =>
  Effect.die(
    new Error(
      "t3 tui is not part of the standalone t3 executable. Run it from the npm package or the desktop app.",
    ),
  );
