import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PsycheDb } from "@psyche/db";
import { getLibraryItem } from "@psyche/db";
import {
  assertNoSymlinks,
  documentFormatOf,
  EXTRACT_LIMITS,
  extractDocument,
  isUnder,
  magicMatches,
} from "@psyche/files";
import type { LibraryItem } from "@psyche/protocol";
import { downscaleImage } from "./image-resize.ts";

/**
 * What a chat message's Library attachments become for the agent (feature P4, UI design §3.2):
 * images ride along as image parts, documents as extracted text ahead of the message. Both are
 * capped so one big attachment cannot drown the context window; what is cut or skipped is said in
 * the text so the agent can tell the owner.
 */

export const ATTACHMENT_LIMITS = {
  /** Largest image sent to the model. */
  imageBytes: 5 * 1024 * 1024,
  /** Images per message. */
  images: 4,
  /** Characters of text taken from one document. */
  docChars: 32_000,
  /** Characters of text across a message's documents. */
  totalChars: 96_000,
  /** Largest plain-text file read. */
  textBytes: 2 * 1024 * 1024,
};

export type TurnImages = { mime: string; data: string }[];

export interface ResolvedAttachments {
  /** Text the agent reads ahead of the message: one block per document, plus any notes. */
  text: string;
  images: TurnImages;
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "log",
  "rtf",
  "ini",
  "toml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "swift",
  "sh",
  "sql",
  "css",
]);

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isTextFile(item: LibraryItem): boolean {
  return item.mime.startsWith("text/") || TEXT_EXTENSIONS.has(extensionOf(item.name));
}

function block(item: LibraryItem, body: string, note?: string): string {
  return [
    `[attached file: ${item.name} (${item.mime}, ${item.size} bytes, library item ${item.id})]`,
    body,
    ...(note === undefined ? [] : [`[${note}]`]),
    "[end of attached file]",
  ].join("\n");
}

function skipped(item: LibraryItem, why: string): string {
  return `[attached file: ${item.name} (library item ${item.id}) was not read: ${why}]`;
}

/** The item's bytes, read through no symlink and only from inside the Library. */
async function readStored(home: string, item: LibraryItem, maxBytes: number): Promise<Buffer> {
  // The Library's real path: the home itself may sit behind a link (macOS's /var), the file may not.
  const root = await realpath(join(home, "library"));
  const target = resolve(root, item.path);
  if (target === root || !isUnder(target, root)) throw new Error("outside the Library");
  await assertNoSymlinks(target);
  const info = await stat(target);
  if (info.size > maxBytes) throw new Error("too large");
  return readFile(target);
}

/**
 * Resolves the attachments of one turn. Never throws for one bad file: it becomes a note instead,
 * so a missing or unreadable attachment does not fail the whole message.
 */
export async function resolveAttachments(
  db: PsycheDb,
  home: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<ResolvedAttachments> {
  const images: TurnImages = [];
  const parts: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const item = getLibraryItem(db, id);
    if (item === undefined) {
      parts.push(`[attached library item ${id} was not found]`);
      continue;
    }
    // Downloads and channel files wait for the owner to open them (UI design §3.12).
    if (item.quarantined === true) {
      parts.push(skipped(item, "it is quarantined"));
      continue;
    }
    try {
      if (IMAGE_MIMES.has(item.mime)) {
        if (images.length >= ATTACHMENT_LIMITS.images) {
          parts.push(skipped(item, `only ${ATTACHMENT_LIMITS.images} images go with a message`));
          continue;
        }
        const bytes = await readStored(home, item, ATTACHMENT_LIMITS.imageBytes);
        const sized = await downscaleImage(bytes, item.mime);
        images.push({ mime: item.mime, data: sized.toString("base64") });
        parts.push(`[attached image: ${item.name} (library item ${item.id}); you can see it]`);
        continue;
      }
      if (chars >= ATTACHMENT_LIMITS.totalChars) {
        parts.push(skipped(item, "the message's attachments already fill the text budget"));
        continue;
      }
      const room = Math.min(ATTACHMENT_LIMITS.docChars, ATTACHMENT_LIMITS.totalChars - chars);
      const format = documentFormatOf(item.name);
      let body: string;
      let note: string | undefined;
      if (format !== undefined) {
        const bytes = await readStored(home, item, EXTRACT_LIMITS.fileBytes);
        if (!magicMatches(format, bytes.subarray(0, 1024))) {
          parts.push(skipped(item, `it is not a ${format.toUpperCase()} file`));
          continue;
        }
        const page = await extractDocument(format, bytes, {
          offset: 0,
          maxChars: room,
          ...(signal === undefined ? {} : { signal }),
        });
        body = page.text;
        if (page.nextOffset !== undefined) {
          note = `cut: showed ${page.to ?? 0} of ${page.total} ${page.unit}s; read_file continues it`;
        }
        if (page.warnings.length > 0) note = [note, ...page.warnings].filter(Boolean).join("; ");
      } else if (isTextFile(item)) {
        const bytes = await readStored(home, item, ATTACHMENT_LIMITS.textBytes);
        const text = bytes.toString("utf8");
        body = text.slice(0, room);
        if (text.length > room) note = `cut: showed ${room} of ${text.length} characters`;
      } else {
        parts.push(skipped(item, `${item.mime} files are not read as text`));
        continue;
      }
      chars += body.length;
      parts.push(block(item, body, note));
    } catch (err) {
      const why = err instanceof Error ? err.message : "it could not be read";
      parts.push(skipped(item, why));
    }
  }
  return { text: parts.join("\n\n"), images };
}
