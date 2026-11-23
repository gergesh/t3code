import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import type * as OpenTui from "@opentui/core";

// Stands in for @opentui/core in the standalone executable, which imports only Node built-ins.
// OpenTUI sits in the node_modules beside the executable and uses top-level await, so it is
// imported from there when the TUI creates its renderer. The TUI uses no OpenTUI value before that.
export let BoxRenderable: typeof OpenTui.BoxRenderable;
export let MarkdownRenderable: typeof OpenTui.MarkdownRenderable;
export let RGBA: typeof OpenTui.RGBA;
export let ScrollBoxRenderable: typeof OpenTui.ScrollBoxRenderable;
export let StyledText: typeof OpenTui.StyledText;
export let SyntaxStyle: typeof OpenTui.SyntaxStyle;
export let TextAttributes: typeof OpenTui.TextAttributes;
export let TextRenderable: typeof OpenTui.TextRenderable;
export let TextareaRenderable: typeof OpenTui.TextareaRenderable;

export const createCliRenderer: typeof OpenTui.createCliRenderer = async (config) => {
  const entry = NodeModule.createRequire(import.meta.url).resolve("@opentui/core");
  const core: typeof OpenTui = await import(NodeURL.pathToFileURL(entry).href);
  ({
    BoxRenderable,
    MarkdownRenderable,
    RGBA,
    ScrollBoxRenderable,
    StyledText,
    SyntaxStyle,
    TextAttributes,
    TextRenderable,
    TextareaRenderable,
  } = core);
  return core.createCliRenderer(config);
};
