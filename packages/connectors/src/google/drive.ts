import { randomBytes } from "node:crypto";
import { PsycheError } from "@psyche/protocol";
import type { LibrarySink } from "../framework/types.ts";
import type { GoogleApi } from "./api.ts";
import { sanitizeFilename } from "./mime.ts";

/**
 * Drive API v3 with the non-sensitive `drive.file` scope: only files Psyche created or the owner
 * opened with it. Downloads go to the Library; Google-native docs are exported as PDF.
 */
export const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const MAX_DRIVE_BYTES = 50 * 1024 * 1024;

export class Drive {
  readonly #api: GoogleApi;

  constructor(api: GoogleApi) {
    this.#api = api;
  }

  async upload(
    input: { name: string; mimeType: string; bytes: Uint8Array; parentId?: string },
    signal?: AbortSignal,
  ) {
    if (input.bytes.byteLength > MAX_DRIVE_BYTES)
      throw new PsycheError("invalid_params", "file is too large");
    if (/[\r\n]/.test(input.mimeType)) throw new PsycheError("invalid_params", "invalid mime type");
    const boundary = `psyche-${randomBytes(12).toString("hex")}`;
    const meta = {
      name: sanitizeFilename(input.name),
      ...(input.parentId === undefined ? {} : { parents: [input.parentId] }),
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      ),
      Buffer.from(`--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
      Buffer.from(input.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.#api.json<{ id?: string; name?: string; webViewLink?: string }>(DRIVE_UPLOAD, {
      method: "POST",
      query: { uploadType: "multipart", fields: "id,name,webViewLink" },
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async download(
    input: { connectorId: string; fileId: string },
    library: LibrarySink | undefined,
    signal?: AbortSignal,
  ) {
    if (library === undefined) throw new PsycheError("unavailable", "no Library is configured");
    const id = encodeURIComponent(input.fileId);
    const meta = await this.#api.json<{ name?: string; mimeType?: string; size?: string }>(
      `${DRIVE_BASE}/files/${id}`,
      {
        query: { fields: "name,mimeType,size" },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (Number(meta.size ?? "0") > MAX_DRIVE_BYTES)
      throw new PsycheError("invalid_params", "file is too large");
    const native = (meta.mimeType ?? "").startsWith("application/vnd.google-apps.");
    const url = native ? `${DRIVE_BASE}/files/${id}/export` : `${DRIVE_BASE}/files/${id}`;
    const { bytes, contentType } = await this.#api.bytes(url, MAX_DRIVE_BYTES, {
      query: native ? { mimeType: "application/pdf" } : { alt: "media" },
      ...(signal === undefined ? {} : { signal }),
    });
    return library.put({
      name: sanitizeFilename(meta.name ?? input.fileId) + (native ? ".pdf" : ""),
      mimeType: native ? "application/pdf" : contentType,
      bytes,
      source: { connectorId: input.connectorId, ref: `drive:${input.fileId}` },
      provenance: "untrusted",
    });
  }
}
