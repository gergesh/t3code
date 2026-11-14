import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * The paths in pasted text when every part names an image file, as terminals
 * paste a dragged file: quoted, backslash-escaped, or as a `file://` URL.
 */
export function pastedImagePaths(text: string): ReadonlyArray<string> | null {
  const parts = text
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => line.match(/'[^']+'|"[^"]+"|(?:\\.|[^\s\\])+/g) ?? [])
    .map((part) => {
      const unquoted = /^(['"])(.*)\1$/.exec(part)?.[2] ?? part.replace(/\\(.)/g, "$1");
      return unquoted.startsWith("file://") ? decodeURIComponent(unquoted.slice(7)) : unquoted;
    });
  if (parts.length === 0) return null;
  const isImage = (part: string) =>
    (part.startsWith("/") || part.startsWith("~/")) &&
    Object.keys(IMAGE_TYPES).some((extension) => part.toLowerCase().endsWith(extension));
  return parts.every(isImage) ? parts : null;
}

export const readImageAttachment = Effect.fn("Tui.readImageAttachment")(function* (
  filePath: string,
  name?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = filePath.startsWith("~/")
    ? path.join(yield* HostProcess.HomeDirectory, filePath.slice(2))
    : filePath;
  const mimeType = IMAGE_TYPES[path.extname(resolved).toLowerCase()];
  if (mimeType === undefined)
    return yield* Effect.fail(`${path.basename(resolved)} is not an image.`);
  const bytes = yield* fileSystem
    .readFile(resolved)
    .pipe(Effect.mapError(() => `Could not read ${resolved}.`));
  if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return yield* Effect.fail(`${path.basename(resolved)} is larger than 10 MB.`);
  }
  return {
    type: "image",
    name: name ?? path.basename(resolved),
    mimeType,
    sizeBytes: bytes.byteLength,
    dataUrl: `data:${mimeType};base64,${Base64.encode(bytes)}`,
  } satisfies UploadChatImageAttachment;
});

/** Commands that write the clipboard's image to a file, per platform, tried in order. */
const clipboardCommands = (
  platform: NodeJS.Platform,
  file: string,
): ReadonlyArray<ChildProcess.Command> =>
  platform === "darwin"
    ? [
        ChildProcess.make("osascript", [
          "-e",
          `set f to open for access POSIX file "${file}" with write permission`,
          "-e",
          "write (the clipboard as «class PNGf») to f",
          "-e",
          "close access f",
        ]),
      ]
    : platform === "linux"
      ? [
          ChildProcess.make("sh", ["-c", 'wl-paste --type image/png > "$0"', file]),
          ChildProcess.make("sh", [
            "-c",
            'xclip -selection clipboard -t image/png -o > "$0"',
            file,
          ]),
        ]
      : [];

/** The clipboard's image, or a reason there is none. */
export const readClipboardImage = Effect.fn("Tui.readClipboardImage")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const directory = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "t3-tui-paste-" })
    .pipe(Effect.mapError(() => "Could not make a folder for the pasted image."));
  const file = path.join(directory, "pasted.png");
  for (const command of clipboardCommands(yield* HostProcess.Platform, file)) {
    const code = yield* spawner.exitCode(command).pipe(Effect.orElseSucceed(() => 1));
    const size = yield* fileSystem.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (code === 0 && size > 0) return yield* readImageAttachment(file, "pasted.png");
  }
  return yield* Effect.fail("There is no image on the clipboard.");
}, Effect.scoped);
