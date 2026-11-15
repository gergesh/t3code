import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import {
  createThreadMediaLinksCollector,
  type ThreadMediaEntry,
} from "@t3tools/client-runtime/thread-media-links";
import type { AssetResource, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { chatMarkdownReferences } from "@t3tools/shared/markdownPipeline";
import { videoMimeType } from "@t3tools/shared/video";
import { FileIcon, FilmIcon, GlobeIcon, ImageOffIcon } from "lucide-react";
import { useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { formatBytes } from "../../lib/formatBytes";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadHistory, useTimelineVisibleTurnItems } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { openExpandedImagePreview } from "./ExpandedImageDialog";
import type { ExpandedImageItem } from "./ExpandedImagePreview";

const collectThreadMediaLinks = createThreadMediaLinksCollector(chatMarkdownReferences);

interface MediaTarget {
  readonly entry: ThreadMediaEntry;
  readonly name: string;
  readonly mimeType?: string;
  readonly direct?: string;
  readonly resource?: AssetResource;
  readonly srcFragment: string;
  readonly reference?: MediaReference;
}

function mediaTarget(
  entry: ThreadMediaEntry,
  threadRef: ScopedThreadRef,
  workspaceRoot: string | undefined,
): MediaTarget | null {
  if (entry.source === "attachment") {
    const { attachment } = entry;
    return {
      entry,
      name: attachment.name,
      mimeType: attachment.mimeType,
      srcFragment: "",
      // The timeline signs image attachments under this exact resource, so their URLs are shared.
      resource:
        entry.kind === "image"
          ? { _tag: "attachment", attachmentId: attachment.id }
          : {
              _tag: "attachment",
              attachmentId: attachment.id,
              fileName: attachment.name,
              mimeType: videoMimeType(attachment) ?? attachment.mimeType,
            },
    };
  }
  const media = resolveMediaSource(entry.src, {
    threadId: threadRef.threadId,
    workspaceRoot,
    imageEmbed: true,
  });
  if (media === null || media.access === "unavailable") return null;
  const common = {
    entry,
    name: media.name,
    mimeType: media.mimeType,
    srcFragment: media.srcFragment,
    ...(media.reference?.kind === "url" ? { reference: media.reference } : {}),
  };
  return media.access === "direct"
    ? { ...common, direct: resolveProtocolRelativeMediaUrl(media.uri) }
    : { ...common, resource: media.resource };
}

function galleryItem(
  target: MediaTarget,
  src: string | null,
  environmentId: EnvironmentId,
): ExpandedImageItem {
  const kind = target.entry.kind;
  return {
    src,
    name: target.name,
    ...(target.mimeType && !target.mimeType.endsWith("/*") ? { mimeType: target.mimeType } : {}),
    ...(kind === "video" ? { type: "video" as const, autoPlay: false } : {}),
    ...(target.direct && target.reference ? { originalUrl: target.direct } : {}),
    ...(target.srcFragment ? { srcFragment: target.srcFragment } : {}),
    actionsSource: {
      kind,
      name: target.name,
      src,
      ...(target.reference ? { reference: target.reference } : {}),
      ...(target.resource ? { asset: { environmentId, resource: target.resource } } : {}),
    },
  };
}

function SectionHeading(props: { readonly title: string; readonly count: number }) {
  return (
    <h3 className="flex items-baseline gap-1.5 px-3 pt-3 pb-1.5 font-medium text-muted-foreground text-xs">
      {props.title}
      <span className="tabular-nums">{props.count}</span>
    </h3>
  );
}

function MediaTile(props: {
  readonly target: MediaTarget;
  readonly src: string | null;
  readonly onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const { target, src } = props;
  const label = `${target.entry.kind === "video" ? "Play" : "Preview"} ${target.name}`;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={props.onOpen}
      className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md border border-border/50 bg-muted/40 text-muted-foreground hover:border-border focus-visible:outline-2 focus-visible:outline-ring"
    >
      {target.entry.kind === "video" ? (
        <FilmIcon aria-hidden className="size-5" />
      ) : src === null || failed ? (
        <ImageOffIcon aria-hidden className="size-5" />
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </button>
  );
}

function LinkFavicon(props: { readonly host: string }) {
  const [failed, setFailed] = useState(false);
  const url = faviconUrlForOrigin(`https://${props.host}`);
  return url === null || failed ? (
    <GlobeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      className="size-4 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
}

export function ThreadMediaLinksPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
}) {
  const { threadRef, workspaceRoot } = props;
  const rows = useTimelineVisibleTurnItems(threadRef);
  const history = useThreadHistory(threadRef);
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const { media, files, links } = collectThreadMediaLinks(rows);
  const targets = media.flatMap((entry) => mediaTarget(entry, threadRef, workspaceRoot) ?? []);
  const resourceTargets = targets.filter((target) => target.resource !== undefined);
  const signedUrls = useAssetUrls(
    threadRef.environmentId,
    resourceTargets.map((target) => target.resource!),
  );
  const signedUrlByTarget = new Map(
    resourceTargets.map((target, index) => {
      const url = signedUrls[index];
      return [target, url ? url + target.srcFragment : null];
    }),
  );
  const srcOf = (target: MediaTarget) => target.direct ?? signedUrlByTarget.get(target) ?? null;

  const openMedia = (index: number) => {
    // Unsigned images cannot show yet; videos sign lazily from their asset.
    const items: ExpandedImageItem[] = [];
    let selected = -1;
    targets.forEach((target, targetIndex) => {
      const src = srcOf(target);
      if (src === null && target.entry.kind !== "video" && targetIndex !== index) return;
      if (targetIndex === index) selected = items.length;
      items.push(galleryItem(target, src, threadRef.environmentId));
    });
    if (selected >= 0) {
      openExpandedImagePreview(scopedThreadKey(threadRef), { images: items, index: selected });
    }
  };

  const isEmpty = targets.length === 0 && files.length === 0 && links.length === 0;
  const loadEarlier = history.hasMoreHistory ? (
    <div className="flex flex-col items-center gap-1 px-3 py-4 text-center">
      <p className="text-muted-foreground text-xs">
        Only loaded messages are listed. Earlier messages may have more.
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={history.loading}
        onClick={() =>
          void loadEarlierHistory({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          })
        }
      >
        {history.loading ? "Loading…" : "Load earlier messages"}
      </Button>
    </div>
  ) : null;

  if (isEmpty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GlobeIcon />
            </EmptyMedia>
            <EmptyTitle>No media or links yet</EmptyTitle>
            <EmptyDescription>
              Images, files, and links shared in this thread will show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        {loadEarlier}
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col pb-3">
        {targets.length > 0 ? (
          <section aria-label="Media">
            <SectionHeading title="Media" count={targets.length} />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1.5 px-3">
              {targets.map((target, index) => (
                <MediaTile
                  key={
                    target.entry.source === "attachment"
                      ? `attachment:${target.entry.attachment.id}`
                      : `src:${target.entry.src}`
                  }
                  target={target}
                  src={srcOf(target)}
                  onOpen={() => openMedia(index)}
                />
              ))}
            </div>
          </section>
        ) : null}
        {files.length > 0 ? (
          <section aria-label="Files">
            <SectionHeading title="Files" count={files.length} />
            <ul className="flex flex-col px-1.5">
              {files.map((entry) => (
                <li key={entry.attachment.id}>
                  <button
                    type="button"
                    onClick={() =>
                      useRightPanelStore.getState().openAttachment(threadRef, entry.attachment)
                    }
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{entry.attachment.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {formatBytes(entry.attachment.sizeBytes)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {links.length > 0 ? (
          <section aria-label="Links">
            <SectionHeading title="Links" count={links.length} />
            <ul className="flex flex-col px-1.5">
              {links.map((entry) => (
                <li key={entry.url}>
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <LinkFavicon host={entry.host} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{entry.host}</span>
                      <span className="truncate text-muted-foreground text-xs">
                        {entry.url.replace(/^https?:\/\//, "")}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {loadEarlier}
      </div>
    </ScrollArea>
  );
}
