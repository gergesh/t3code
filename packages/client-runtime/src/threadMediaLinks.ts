import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  MessageId,
  OrchestrationV2ProjectedTurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import { videoMimeType } from "@t3tools/shared/video";

import { mediaUrlReference } from "./mediaReference.ts";

/** Image sources and link targets as one client's markdown renderer reads them. */
export interface MarkdownReferences {
  readonly images: ReadonlyArray<string>;
  readonly links: ReadonlyArray<string>;
}

interface ThreadMediaLinkOrigin {
  readonly itemId: TurnItemId;
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
}

export type ThreadMediaEntry = ThreadMediaLinkOrigin & { readonly kind: "image" | "video" } & (
    | {
        readonly source: "attachment";
        readonly attachment: ChatImageAttachment | ChatFileAttachment;
      }
    | { readonly source: "markdown"; readonly src: string }
  );

export type ThreadFileEntry = ThreadMediaLinkOrigin & {
  readonly attachment: ChatFileAttachment;
};

export type ThreadLinkEntry = ThreadMediaLinkOrigin & {
  readonly url: string;
  readonly host: string;
};

export interface ThreadMediaLinks {
  readonly media: ReadonlyArray<ThreadMediaEntry>;
  readonly files: ReadonlyArray<ThreadFileEntry>;
  readonly links: ReadonlyArray<ThreadLinkEntry>;
}

type MessageItem = Extract<
  OrchestrationV2ProjectedTurnItem["item"],
  { type: "user_message" | "assistant_message" }
>;

interface MessageMediaLinks {
  readonly media: ReadonlyArray<ThreadMediaEntry>;
  readonly files: ReadonlyArray<ThreadFileEntry>;
  readonly links: ReadonlyArray<ThreadLinkEntry>;
}

function linkHost(url: string): string | null {
  try {
    const host = new URL(url.startsWith("//") ? `https:${url}` : url).host;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function markdownMediaKind(source: string): "image" | "video" | null {
  const kind = mediaKindFromPath(source);
  return kind === "image" || kind === "video" ? kind : null;
}

function isKnownAttachment(
  attachment: ChatAttachment,
): attachment is ChatImageAttachment | ChatFileAttachment {
  return attachment.type === "image" || attachment.type === "file";
}

function readMessage(
  item: MessageItem,
  readMarkdown: (markdown: string) => MarkdownReferences,
): MessageMediaLinks {
  const origin: ThreadMediaLinkOrigin = {
    itemId: item.id,
    messageId: item.messageId,
    role: item.type === "user_message" ? "user" : "assistant",
  };
  const media: ThreadMediaEntry[] = [];
  const files: ThreadFileEntry[] = [];
  const links: ThreadLinkEntry[] = [];
  for (const attachment of item.attachments ?? []) {
    if (!isKnownAttachment(attachment)) continue;
    if (attachment.type === "image") {
      media.push({ ...origin, kind: "image", source: "attachment", attachment });
    } else if (imageMimeType(attachment)) {
      media.push({ ...origin, kind: "image", source: "attachment", attachment });
    } else if (videoMimeType(attachment)) {
      media.push({ ...origin, kind: "video", source: "attachment", attachment });
    } else {
      files.push({ ...origin, attachment });
    }
  }
  if (item.text.length === 0) return { media, files, links };
  const references = readMarkdown(item.text);
  for (const src of references.images) {
    // An embed with no media extension (`/render?id=1`) still renders as an image.
    media.push({ ...origin, kind: markdownMediaKind(src) ?? "image", source: "markdown", src });
  }
  for (const href of references.links) {
    const kind = markdownMediaKind(href);
    if (kind) {
      media.push({ ...origin, kind, source: "markdown", src: href });
      continue;
    }
    const host = mediaUrlReference(href) ? linkHost(href) : null;
    if (host) links.push({ ...origin, url: href, host });
  }
  return { media, files, links };
}

function mediaKey(entry: ThreadMediaEntry) {
  return entry.source === "attachment" ? `attachment:${entry.attachment.id}` : `src:${entry.src}`;
}

/**
 * Collects a thread's media, file attachments, and web links, newest message first, each listed
 * once at its newest mention. The collector caches per turn item object, so pass the same rows
 * the timeline renders.
 */
export function createThreadMediaLinksCollector(
  readMarkdown: (markdown: string) => MarkdownReferences,
) {
  const cache = new WeakMap<MessageItem, MessageMediaLinks>();
  return (rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>): ThreadMediaLinks => {
    const media: ThreadMediaEntry[] = [];
    const files: ThreadFileEntry[] = [];
    const links: ThreadLinkEntry[] = [];
    const seen = new Set<string>();
    const once = (key: string) => !seen.has(key) && Boolean(seen.add(key));
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const item = rows[index]!.item;
      if (item.type !== "user_message" && item.type !== "assistant_message") continue;
      let read = cache.get(item);
      if (!read) {
        read = readMessage(item, readMarkdown);
        cache.set(item, read);
      }
      media.push(...read.media.filter((entry) => once(mediaKey(entry))));
      files.push(...read.files.filter((entry) => once(`attachment:${entry.attachment.id}`)));
      links.push(...read.links.filter((entry) => once(`link:${entry.url}`)));
    }
    return { media, files, links };
  };
}
