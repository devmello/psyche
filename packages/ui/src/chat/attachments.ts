import type { ModelCapabilityGuess, ModelProviderSummary, ModelRoles } from "@psyche/protocol";
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from "@psyche/protocol";
import type { GatewayCall } from "../data/files.ts";
import { toBase64 } from "../data/files.ts";

/**
 * Chat attachments (feature P4; UI design §3.2): which files a thread's model can take, the chips
 * that show them while they upload, and the upload itself (`library.upload`, chunked). The send
 * carries the Library item ids in `chat.send` `attachments`; the Gateway turns images into image
 * parts and documents into extracted text.
 */

/** Files per message; the Gateway takes up to 32, a composer row stops being readable well before. */
export const MAX_ATTACHMENTS = 8;
/** Largest image; the Gateway sends no more than this to a model. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type AttachKind = "image" | "document";

/** What the current model can take: images need vision, documents travel as extracted text. */
export interface AttachSupport {
  images: boolean;
  documents: boolean;
}

/**
 * What a model can take, from its capability guesses. An absent flag is unknown, not false, so
 * unknown support shows the button. Documents are text to the model, so every chat model takes
 * them; only a model that cannot chat at all (an embeddings model) takes nothing. Images need
 * vision unless that is unknown.
 */
export function attachSupport(caps: ModelCapabilityGuess | undefined): AttachSupport {
  const chat = caps?.embeddings !== true;
  return { documents: chat, images: chat && caps?.vision !== false };
}

/**
 * The capability guesses of the thread's model from `models.list`: the thread's pinned model, or
 * the primary role's when the thread has none (or a ref no provider lists, e.g. the router's
 * `router/auto`). Undefined when nothing is known.
 */
export function modelCapabilities(
  models: { providers: readonly ModelProviderSummary[]; roles: ModelRoles } | undefined,
  threadRef: string | null | undefined,
): ModelCapabilityGuess | undefined {
  if (models === undefined) return undefined;
  const find = (ref: string | null | undefined) =>
    ref == null
      ? undefined
      : models.providers.flatMap((p) => p.models).find((m) => m.ref === ref)?.capabilities;
  return find(threadRef) ?? find(models.roles.primary);
}

/** Whether the + button shows. */
export function canAttach(support: AttachSupport): boolean {
  return support.images || support.documents;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const DOCUMENT_EXTENSIONS = [
  "pdf",
  "docx",
  "xlsx",
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
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "swift",
  "sh",
  "sql",
  "css",
];
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The kind of file this is, or null when the Gateway has no way to read it. */
export function classifyFile(file: { name: string; type: string }): AttachKind | null {
  const ext = extensionOf(file.name);
  if (IMAGE_MIMES.has(file.type) || IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.includes(ext) || file.type.startsWith("text/")) return "document";
  if (
    file.type === "application/pdf" ||
    file.type === "application/json" ||
    file.type.startsWith("application/vnd.openxmlformats-officedocument.")
  ) {
    return "document";
  }
  return null;
}

/** The file picker's `accept` for what the model takes. */
export function acceptFor(support: AttachSupport): string {
  return [
    ...(support.documents ? DOCUMENT_EXTENSIONS.map((e) => `.${e}`) : []),
    ...(support.images ? IMAGE_EXTENSIONS.map((e) => `.${e}`) : []),
  ].join(",");
}

export type Refusal = "image" | "type" | "size" | "count";

export interface Refused {
  name: string;
  reason: Refusal;
}

/**
 * Splits dropped, pasted or picked files into the ones to upload and the ones refused, with the
 * reason: an image for a model without vision, a type the Gateway cannot read, a file over the
 * limit, or no room left in the row.
 */
export function admitFiles<F extends { name: string; type: string; size: number }>(
  files: readonly F[],
  support: AttachSupport,
  have: number,
): { accepted: { file: F; kind: AttachKind }[]; refused: Refused[] } {
  const accepted: { file: F; kind: AttachKind }[] = [];
  const refused: Refused[] = [];
  for (const file of files) {
    const kind = classifyFile(file);
    if (kind === null) refused.push({ name: file.name, reason: "type" });
    else if (kind === "image" && !support.images) {
      refused.push({ name: file.name, reason: "image" });
    } else if (kind === "document" && !support.documents) {
      refused.push({ name: file.name, reason: "type" });
    } else if (file.size > (kind === "image" ? MAX_IMAGE_BYTES : UPLOAD_MAX_BYTES)) {
      refused.push({ name: file.name, reason: "size" });
    } else if (have + accepted.length >= MAX_ATTACHMENTS) {
      refused.push({ name: file.name, reason: "count" });
    } else accepted.push({ file, kind });
  }
  return { accepted, refused };
}

export interface AttachmentChip {
  key: string;
  name: string;
  kind: AttachKind;
  status: "uploading" | "ready" | "error";
  /** The Library item, once uploaded. */
  itemId?: string;
}

export type ChipAction =
  | { type: "add"; chips: readonly AttachmentChip[] }
  | { type: "uploaded"; key: string; itemId: string }
  | { type: "failed"; key: string }
  | { type: "remove"; key: string }
  | { type: "clear" };

export function chipsReducer(
  chips: readonly AttachmentChip[],
  action: ChipAction,
): readonly AttachmentChip[] {
  switch (action.type) {
    case "add":
      return [...chips, ...action.chips];
    case "uploaded":
      return chips.map((c) =>
        c.key === action.key && c.status === "uploading"
          ? { ...c, status: "ready", itemId: action.itemId }
          : c,
      );
    case "failed":
      return chips.map((c) =>
        c.key === action.key && c.status === "uploading" ? { ...c, status: "error" } : c,
      );
    case "remove":
      return chips.filter((c) => c.key !== action.key);
    case "clear":
      return [];
  }
}

/** The Library ids `chat.send` carries: the chips that finished uploading. */
export function attachmentIds(chips: readonly AttachmentChip[]): string[] {
  return chips.flatMap((c) => (c.status === "ready" && c.itemId !== undefined ? [c.itemId] : []));
}

/** Sending waits for the uploads; a failed chip does not block it (it is not sent). */
export function uploading(chips: readonly AttachmentChip[]): boolean {
  return chips.some((c) => c.status === "uploading");
}

/** Reads a file in `UPLOAD_CHUNK_BYTES` pieces into `library.upload`; returns the item's id. */
export async function uploadFile(
  call: GatewayCall,
  file: Blob & { name: string },
  options: { threadId?: string; signal?: AbortSignal } = {},
): Promise<string> {
  let uploadId: string | undefined;
  let offset = 0;
  do {
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const res = await call("library.upload", {
      name: file.name,
      ...(file.type === "" ? {} : { mime: file.type }),
      ...(uploadId === undefined ? {} : { uploadId }),
      bytes: toBase64(bytes),
      final: end >= file.size,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    });
    uploadId = res.uploadId;
    offset = end;
    if (end >= file.size) {
      if (res.item === undefined) throw new Error("the Gateway returned no item");
      return res.item.id;
    }
  } while (offset < file.size);
  throw new Error("unreachable");
}
