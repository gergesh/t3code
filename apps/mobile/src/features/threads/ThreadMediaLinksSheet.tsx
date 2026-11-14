import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { LegendList } from "@legendapp/list/react-native";
import {
  createThreadMediaLinksCollector,
  type ThreadFileEntry,
  type ThreadLinkEntry,
  type ThreadMediaEntry,
} from "@t3tools/client-runtime/thread-media-links";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { Image as ExpoImage } from "expo-image";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FilePreviewModal } from "../../components/ui/FilePreviewModal";
import type {
  FilePreviewItem,
  FilePreviewSource,
} from "../../components/ui/FilePreviewModal.types";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { formatBytes } from "../../lib/formatBytes";
import { markdownReferences } from "../../lib/markdownImageSources";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useAssetUrl } from "../../state/assets";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  useSelectedThreadDetailState,
  useSelectedThreadTimelineTurnItems,
} from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { requestThreadMessageJump } from "./threadMessageJump";

const collectThreadMediaLinks = createThreadMediaLinksCollector(markdownReferences);
const MEDIA_COLUMNS = 4;

interface MediaTile {
  readonly entry: ThreadMediaEntry;
  readonly key: string;
  /** Absent for videos, which play in the thread. */
  readonly preview: FilePreviewItem | null;
}

type SheetRow =
  | {
      readonly type: "heading";
      readonly key: string;
      readonly title: string;
      readonly count: number;
    }
  | { readonly type: "media"; readonly key: string; readonly tiles: ReadonlyArray<MediaTile> }
  | { readonly type: "file"; readonly key: string; readonly entry: ThreadFileEntry }
  | { readonly type: "link"; readonly key: string; readonly entry: ThreadLinkEntry };

function mediaTile(
  entry: ThreadMediaEntry,
  context: { environmentId: EnvironmentId; threadId: ThreadId; workspaceRoot: string | null },
): MediaTile | null {
  if (entry.source === "attachment") {
    const { attachment } = entry;
    const resource = {
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
    };
    return {
      entry,
      key: `attachment:${attachment.id}`,
      preview:
        entry.kind === "image"
          ? {
              kind: "image",
              name: attachment.name,
              environmentId: context.environmentId,
              resource,
              actionsSource: {
                name: attachment.name,
                mimeType: attachment.mimeType,
                environmentId: context.environmentId,
                resource,
              },
            }
          : null,
    };
  }
  const preview = resolveMarkdownMediaPreview(entry.src, { ...context, imageEmbed: true });
  if (preview === null) return null;
  return {
    entry,
    key: `src:${entry.src}`,
    preview: preview.kind === "image" ? preview.source : null,
  };
}

function MediaThumbnail(props: { readonly tile: MediaTile; readonly onPress: () => void }) {
  const preview = props.tile.preview;
  const resourceUri = useAssetUrl(
    preview && "resource" in preview ? preview.environmentId : null,
    preview && "resource" in preview ? preview.resource : null,
  );
  const uri = preview && "uri" in preview ? preview.uri : resourceUri;
  const video = props.tile.entry.kind === "video";
  return (
    <Pressable
      accessibilityRole={video ? "button" : "imagebutton"}
      accessibilityLabel={video ? "Show video in thread" : `Open ${preview?.name ?? "image"}`}
      onPress={props.onPress}
      className="aspect-square flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-subtle"
    >
      {video || uri === null ? (
        <SymbolView
          name={video ? "play" : "photo"}
          size={20}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : (
        <ExpoImage
          source={{ uri }}
          cachePolicy="memory-disk"
          contentFit="cover"
          recyclingKey={props.tile.key}
          style={{ width: "100%", height: "100%" }}
        />
      )}
    </Pressable>
  );
}

export function ThreadMediaLinksSheet(
  _props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const turnItems = useSelectedThreadTimelineTurnItems();
  const history = useSelectedThreadDetailState().history;
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState<FilePreviewSource | null>(null);

  if (!selectedThread) return null;
  const environmentId = selectedThread.environmentId;
  const threadId = selectedThread.id;
  const { media, files, links } = collectThreadMediaLinks(turnItems);
  const tiles = media.flatMap(
    (entry) =>
      mediaTile(entry, { environmentId, threadId, workspaceRoot: selectedThreadCwd }) ?? [],
  );
  const gallery = tiles.flatMap((tile) => (tile.preview ? [tile.preview] : []));

  const jumpToMessage = (messageId: MessageId) => {
    requestThreadMessageJump(scopedThreadKey(environmentId, threadId), messageId);
    navigation.goBack();
  };
  const openTile = (tile: MediaTile) => {
    if (tile.preview) setExpanded({ ...tile.preview, gallery });
    else jumpToMessage(tile.entry.messageId);
  };

  const rows: SheetRow[] = [];
  if (tiles.length > 0) {
    rows.push({ type: "heading", key: "heading:media", title: "Media", count: tiles.length });
    for (let index = 0; index < tiles.length; index += MEDIA_COLUMNS) {
      const chunk = tiles.slice(index, index + MEDIA_COLUMNS);
      rows.push({ type: "media", key: `media:${chunk[0]!.key}`, tiles: chunk });
    }
  }
  if (files.length > 0) {
    rows.push({ type: "heading", key: "heading:files", title: "Files", count: files.length });
    for (const entry of files)
      rows.push({ type: "file", key: `file:${entry.attachment.id}`, entry });
  }
  if (links.length > 0) {
    rows.push({ type: "heading", key: "heading:links", title: "Links", count: links.length });
    for (const entry of links) rows.push({ type: "link", key: `link:${entry.url}`, entry });
  }

  const renderRow = (row: SheetRow) => {
    switch (row.type) {
      case "heading":
        return (
          <Text className="px-2 pt-4 pb-2 font-t3-medium text-xs text-foreground-muted">
            {row.title} {row.count}
          </Text>
        );
      case "media":
        return (
          <View className="flex-row gap-1.5 pb-1.5">
            {Array.from({ length: MEDIA_COLUMNS }, (_, column) => {
              const tile = row.tiles[column];
              return tile ? (
                <MediaThumbnail key={tile.key} tile={tile} onPress={() => openTile(tile)} />
              ) : (
                <View key={`empty:${column}`} className="flex-1" />
              );
            })}
          </View>
        );
      case "file":
        return (
          <RowPressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${row.entry.attachment.name}`}
            onLongPress={() => jumpToMessage(row.entry.messageId)}
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(environmentId),
                threadId: String(threadId),
                attachmentId: row.entry.attachment.id,
                name: row.entry.attachment.name,
                mimeType: row.entry.attachment.mimeType,
                sizeBytes: String(row.entry.attachment.sizeBytes),
              })
            }
            className="flex-row items-center gap-3 rounded-lg px-2 py-2.5"
          >
            <SymbolView
              name="doc"
              size={18}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
              {row.entry.attachment.name}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {formatBytes(row.entry.attachment.sizeBytes)}
            </Text>
          </RowPressable>
        );
      case "link":
        return (
          <RowPressable
            accessibilityRole="link"
            accessibilityLabel={row.entry.url}
            onLongPress={() => jumpToMessage(row.entry.messageId)}
            onPress={() => void tryOpenExternalUrl(row.entry.url, "markdown-link")}
            className="flex-row items-center gap-3 rounded-lg px-2 py-2.5"
          >
            <SymbolView
              name="globe"
              size={18}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {row.entry.host}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {row.entry.url.replace(/^https?:\/\//, "")}
              </Text>
            </View>
          </RowPressable>
        );
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Media & links" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <View className="flex-1 bg-screen">
          {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling. */}
          <LegendList
            data={rows}
            keyExtractor={(row) => row.key}
            extraData={gallery}
            getItemType={(row) => row.type}
            renderItem={({ item }) => renderRow(item)}
            estimatedItemSize={56}
            recycleItems
            alwaysBounceVertical
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="automatic"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Math.max(insets.bottom, 18) + 18,
              paddingHorizontal: 12,
            }}
            ListEmptyComponent={
              <Text className="pt-6 text-center text-sm text-foreground-muted">
                No media or links yet.
              </Text>
            }
            ListFooterComponent={
              history.hasMoreHistory ? (
                <View className="items-center gap-2 px-4 pt-4">
                  <Text className="text-center text-xs text-foreground-muted">
                    Only loaded messages are listed. Earlier messages may have more.
                  </Text>
                  <Button
                    label="Load earlier messages"
                    size="compact"
                    loading={history.loading}
                    onPress={() => void loadEarlierHistory({ environmentId, input: { threadId } })}
                  />
                </View>
              ) : null
            }
          />
        </View>
      </ScreenContent>
      <FilePreviewModal source={expanded} onRequestClose={() => setExpanded(null)} />
    </View>
  );
}
