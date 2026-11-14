import {
  BoxRenderable,
  MarkdownRenderable,
  RGBA,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type ScrollBoxRenderable,
  type TextChunk,
} from "@opentui/core";

import type { TimelineRow, TodoStep } from "./timeline.ts";

export const color = {
  text: "#d5d8e6",
  muted: "#8a8fa8",
  subtle: "#565b73",
  accent: "#7aa2f7",
  purple: "#bb9af7",
  user: "#e0e4f5",
  userBackground: "#252a3d",
  surface: "#1d2030",
  selection: "#2f3650",
  error: "#f7768e",
  warning: "#e0af68",
  success: "#9ece6a",
  code: "#9bd1ff",
} as const;

/** A run of text in one style; a line is a list of these. */
export interface Segment {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly dim?: boolean;
  readonly strike?: boolean;
}

export function styled(segments: ReadonlyArray<Segment>): StyledText {
  return new StyledText(
    segments.map((segment): TextChunk => ({
      __isChunk: true,
      text: segment.text,
      ...(segment.fg ? { fg: RGBA.fromHex(segment.fg) } : {}),
      ...(segment.bg ? { bg: RGBA.fromHex(segment.bg) } : {}),
      attributes:
        (segment.bold ? TextAttributes.BOLD : 0) |
        (segment.italic ? TextAttributes.ITALIC : 0) |
        (segment.dim ? TextAttributes.DIM : 0) |
        (segment.strike ? TextAttributes.STRIKETHROUGH : 0),
    })),
  );
}

const THINKING_PREVIEW_LINES = 3;
const DETAIL_TAIL_LINES = 40;

function markdownStyle(renderer: CliRenderer) {
  const fg = (hex: string) => RGBA.fromHex(hex);
  return SyntaxStyle.fromStyles(
    {
      default: { fg: fg(color.text) },
      conceal: { fg: fg(color.subtle) },
      keyword: { fg: fg(color.purple), bold: true },
      string: { fg: fg(color.success) },
      comment: { fg: fg(color.subtle), italic: true },
      function: { fg: fg(color.accent) },
      number: { fg: fg(color.warning) },
      "markup.heading": { fg: fg(color.accent), bold: true },
      "markup.strong": { fg: fg(color.user), bold: true },
      "markup.italic": { fg: fg(color.text), italic: true },
      "markup.list": { fg: fg(color.accent) },
      "markup.quote": { fg: fg(color.muted), italic: true },
      "markup.raw": { fg: fg(color.code) },
      "markup.raw.block": { fg: fg(color.code) },
      "markup.link": { fg: fg(color.accent), underline: true },
      "markup.link.label": { fg: fg(color.accent), underline: true },
      "markup.link.url": { fg: fg(color.subtle) },
    },
    renderer.nativeScene,
  );
}

function tail(text: string, lines: number): ReadonlyArray<string> {
  const all = text.trimEnd().split("\n");
  return all.length > lines ? [`… ${all.length - lines} earlier lines`, ...all.slice(-lines)] : all;
}

function gutter(row: TimelineRow): Segment {
  switch (row.tone) {
    case "assistant":
      return { text: "● ", fg: color.text };
    case "thinking":
      return { text: "✻ ", fg: color.subtle };
    case "tool":
      return {
        text: "● ",
        fg: row.failed ? color.error : row.active ? color.warning : color.success,
      };
    case "todo":
      return { text: "☰ ", fg: color.accent };
    case "error":
      return { text: "✗ ", fg: color.error };
    default:
      return { text: "· ", fg: color.subtle };
  }
}

function todoLine(step: TodoStep): ReadonlyArray<Segment> {
  switch (step.status) {
    case "completed":
      return [
        { text: "✔ ", fg: color.success },
        { text: step.text, fg: color.muted, strike: true },
      ];
    case "running":
      return [
        { text: "▸ ", fg: color.warning },
        { text: step.text, fg: color.text, bold: true },
      ];
    case "pending":
      return [
        { text: "○ ", fg: color.subtle },
        { text: step.text, fg: color.muted },
      ];
  }
}

/** Everything right of the gutter, for rows drawn as text. */
export function rowBody(row: TimelineRow, verbose: boolean): ReadonlyArray<Segment> {
  switch (row.tone) {
    case "user":
      return [{ text: row.text, fg: color.user }];
    case "thinking": {
      const lines = row.text.split("\n");
      const shown =
        verbose || lines.length <= THINKING_PREVIEW_LINES
          ? row.text
          : `${lines.slice(0, THINKING_PREVIEW_LINES).join("\n")}\n…`;
      return [{ text: shown, fg: color.muted, italic: true }];
    }
    case "todo":
      return (row.todos ?? []).flatMap((step, index) => [
        ...(index === 0 ? [] : [{ text: "\n" }]),
        ...todoLine(step),
      ]);
    case "tool": {
      const tool = row.tool;
      if (tool === undefined) return [{ text: row.text, fg: color.muted }];
      const segments: Segment[] = [
        { text: tool.verb, fg: row.failed ? color.error : color.text, bold: true },
      ];
      if (tool.target) segments.push({ text: ` ${tool.target}`, fg: color.muted });
      if (tool.added !== undefined) segments.push({ text: `  +${tool.added}`, fg: color.success });
      if (tool.removed !== undefined) segments.push({ text: ` -${tool.removed}`, fg: color.error });
      if (tool.note) segments.push({ text: `  ${tool.note}`, fg: color.warning });
      if (verbose && row.detail) {
        const lines = tail(row.detail, DETAIL_TAIL_LINES);
        segments.push({
          text: `\n${lines.map((line, index) => `${index === 0 ? "⎿ " : "  "}${line}`).join("\n")}`,
          fg: color.subtle,
        });
      }
      return segments;
    }
    case "error":
      return [{ text: row.text, fg: color.error }];
    default:
      return [{ text: row.text, fg: color.muted }];
  }
}

interface MountedRow {
  readonly node: BoxRenderable;
  readonly gutter: TextRenderable | null;
  readonly body: TextRenderable | MarkdownRenderable;
  row: TimelineRow;
}

/**
 * Keeps one renderable per timeline row and updates it in place, so a
 * streaming message re-renders only its own text.
 */
export function makeTimeline(renderer: CliRenderer, scroll: ScrollBoxRenderable) {
  const style = markdownStyle(renderer);
  let mounted = new Map<string, MountedRow>();
  let order: string[] = [];
  let verbose = false;

  const create = (row: TimelineRow): MountedRow => {
    if (row.tone === "user") {
      const node = new BoxRenderable(renderer, {
        flexDirection: "row",
        backgroundColor: color.userBackground,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
      });
      const prompt = new TextRenderable(renderer, {
        content: styled([{ text: "❯ ", fg: color.accent, bold: true }]),
        flexShrink: 0,
      });
      const body = new TextRenderable(renderer, {
        content: styled(rowBody(row, verbose)),
        flexGrow: 1,
        flexShrink: 1,
      });
      node.add(prompt);
      node.add(body);
      return { node, gutter: null, body, row };
    }
    const node = new BoxRenderable(renderer, {
      flexDirection: "row",
      marginTop: row.tone === "assistant" || row.tone === "todo" ? 1 : 0,
      paddingLeft: 1,
    });
    const glyph = new TextRenderable(renderer, {
      content: styled([gutter(row)]),
      flexShrink: 0,
    });
    const body =
      row.tone === "assistant"
        ? new MarkdownRenderable(renderer, {
            content: row.text,
            syntaxStyle: style,
            streaming: row.active,
            flexGrow: 1,
            flexShrink: 1,
          })
        : new TextRenderable(renderer, {
            content: styled(rowBody(row, verbose)),
            flexGrow: 1,
            flexShrink: 1,
          });
    node.add(glyph);
    node.add(body);
    return { node, gutter: glyph, body, row };
  };

  const refresh = (entry: MountedRow, row: TimelineRow, force: boolean) => {
    if (!force && entry.row === row) return;
    if (entry.body instanceof MarkdownRenderable) {
      if (entry.row.text !== row.text || force) entry.body.content = row.text;
      entry.body.streaming = row.active;
    } else {
      entry.body.content = styled(rowBody(row, verbose));
    }
    if (entry.gutter !== null) entry.gutter.content = styled([gutter(row)]);
    entry.row = row;
  };

  const clear = () => {
    for (const entry of mounted.values()) {
      scroll.remove(entry.node);
      entry.node.destroyRecursively();
    }
    mounted = new Map();
    order = [];
  };

  let latest: ReadonlyArray<TimelineRow> = [];
  const render = (rows: ReadonlyArray<TimelineRow>, force = false) => {
    latest = rows;
    const ids = rows.map((row) => row.id);
    // Earlier history, another thread, or a row changing kind reorders the list; rebuild then.
    const reordered =
      !order.every((id, index) => ids[index] === id) ||
      rows.some((row) => {
        const existing = mounted.get(row.id);
        return existing !== undefined && existing.row.tone !== row.tone;
      });
    if (reordered) clear();
    for (const row of rows) {
      const existing = mounted.get(row.id);
      if (existing !== undefined) {
        refresh(existing, row, force);
        continue;
      }
      const entry = create(row);
      mounted.set(row.id, entry);
      order.push(row.id);
      scroll.add(entry.node);
    }
  };

  return {
    render: (rows: ReadonlyArray<TimelineRow>) => render(rows),
    setVerbose: (next: boolean) => {
      verbose = next;
      render(latest, true);
    },
  };
}
