import type { ChatAttachment, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createThreadMediaLinksCollector, type MarkdownReferences } from "./threadMediaLinks.ts";

function message(
  id: string,
  input: {
    role?: "user" | "assistant";
    text?: string;
    attachments?: ReadonlyArray<Pick<ChatAttachment, "type" | "id" | "name" | "mimeType">>;
  },
): OrchestrationV2ProjectedTurnItem {
  return {
    item: {
      id,
      messageId: `message-${id}`,
      type: input.role === "user" ? "user_message" : "assistant_message",
      text: input.text ?? "",
      attachments: input.attachments ?? [],
    },
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

const references: Record<string, MarkdownReferences> = {
  first: {
    images: ["/work/shot.png", "https://cdn.example.com/render?id=1"],
    links: ["https://www.example.com/docs", "./src/app.ts", "https://example.com/clip.mp4"],
  },
  second: { images: [], links: ["https://www.example.com/docs", "mailto:a@example.com"] },
};

describe("createThreadMediaLinksCollector", () => {
  it("sorts attachments, embeds, and links newest first and lists each once", () => {
    const collect = createThreadMediaLinksCollector((text) => references[text]!);
    const result = collect([
      message("1", {
        role: "user",
        attachments: [
          { type: "image", id: "img", name: "a.png", mimeType: "image/png" },
          { type: "file", id: "legacy", name: "b.jpg", mimeType: "application/octet-stream" },
          { type: "file", id: "vid", name: "c.mov", mimeType: "video/quicktime" },
          { type: "file", id: "doc", name: "d.pdf", mimeType: "application/pdf" },
          { type: "sticker", id: "unknown", name: "e", mimeType: "x/y" },
        ],
      }),
      { item: { id: "tool", type: "tool_call" } } as unknown as OrchestrationV2ProjectedTurnItem,
      message("2", { text: "first" }),
      message("3", { text: "second" }),
    ]);

    expect(
      result.media.map((entry) => [
        entry.itemId,
        entry.kind,
        entry.source === "attachment" ? entry.attachment.id : entry.src,
      ]),
    ).toEqual([
      ["2", "image", "/work/shot.png"],
      ["2", "image", "https://cdn.example.com/render?id=1"],
      ["2", "video", "https://example.com/clip.mp4"],
      ["1", "image", "img"],
      ["1", "image", "legacy"],
      ["1", "video", "vid"],
    ]);
    expect(result.files.map((entry) => entry.attachment.id)).toEqual(["doc"]);
    expect(result.links).toEqual([
      {
        itemId: "3",
        messageId: "message-3",
        role: "assistant",
        url: "https://www.example.com/docs",
        host: "example.com",
      },
    ]);
  });

  it("reads each message's markdown once while its row is unchanged", () => {
    const read = vi.fn((text: string) => references[text]!);
    const collect = createThreadMediaLinksCollector(read);
    const rows = [message("2", { text: "first" })];
    collect(rows);
    collect([...rows, message("3", { text: "second" })]);
    expect(read.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
  });
});
