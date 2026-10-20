import { PsycheError } from "@psyche/protocol";
import type { LibrarySink } from "../framework/types.ts";
import { MAX_ATTACHMENT_BYTES, sanitizeFilename } from "../google/mime.ts";
import type { GraphApi } from "./api.ts";

/**
 * OneDrive limited to Psyche's own app folder (`Files.ReadWrite.AppFolder`, like Google
 * `drive.file`): list it, download into the Library (25 MB cap, untrusted), upload text (simple
 * upload, 4 MB). Downloads follow Graph's redirect to a pre-authenticated URL without the token.
 */
export const ONEDRIVE_MAX_UPLOAD = 4 * 1024 * 1024;

export class OneDriveAppFolder {
  readonly #api: GraphApi;

  constructor(api: GraphApi) {
    this.#api = api;
  }

  async list(signal?: AbortSignal) {
    const r = await this.#api.json<{ value?: Record<string, unknown>[] }>(
      "/me/drive/special/approot/children",
      {
        query: { $select: "id,name,size,file,folder,lastModifiedDateTime", $top: 200 },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return (r.value ?? []).map((i) => ({
      id: String(i.id ?? ""),
      name: String(i.name ?? "").slice(0, 300),
      size: typeof i.size === "number" ? i.size : 0,
      folder: i.folder !== undefined,
      mimeType: String((i.file as { mimeType?: unknown } | undefined)?.mimeType ?? ""),
      modified: String(i.lastModifiedDateTime ?? ""),
    }));
  }

  async download(
    input: { connectorId: string; itemId: string },
    library: LibrarySink | undefined,
    signal?: AbortSignal,
  ) {
    if (library === undefined)
      throw new PsycheError("unavailable", "no Library to save the file into");
    const id = encodeURIComponent(input.itemId);
    const meta = await this.#api.json<{
      name?: string;
      size?: number;
      file?: { mimeType?: string };
    }>(`/me/drive/items/${id}`, {
      query: { $select: "name,size,file" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (meta.file === undefined) throw new PsycheError("invalid_params", "that item is a folder");
    if ((meta.size ?? 0) > MAX_ATTACHMENT_BYTES)
      throw new PsycheError("invalid_params", "file is larger than 25 MB");
    const res = await this.#api.request(`/me/drive/items/${id}/content`, {
      ...(signal === undefined ? {} : { signal }),
    });
    const location = res.headers.get("location");
    const bytes =
      res.status >= 300 && res.status < 400 && location !== null
        ? await this.#api.download(location, MAX_ATTACHMENT_BYTES, signal)
        : new Uint8Array(await res.arrayBuffer());
    const name = sanitizeFilename(meta.name ?? "file");
    const mimeType = meta.file.mimeType ?? "application/octet-stream";
    const saved = await library.put({
      name,
      mimeType,
      bytes,
      source: { connectorId: input.connectorId, ref: `onedrive:${input.itemId}` },
      provenance: "untrusted",
    });
    return { ...saved, name, mimeType, size: bytes.byteLength };
  }

  async upload(input: { name: string; content: string; mimeType?: string }, signal?: AbortSignal) {
    const name = sanitizeFilename(input.name).replace(/[:*?"<>|#%]/g, "_");
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.byteLength > ONEDRIVE_MAX_UPLOAD)
      throw new PsycheError("invalid_params", "uploads are limited to 4 MB");
    const item = await this.#api.json<{ id?: string; name?: string; webUrl?: string }>(
      `/me/drive/special/approot:/${encodeURIComponent(name)}:/content`,
      {
        method: "PUT",
        body: bytes,
        contentType: input.mimeType ?? "text/plain",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return {
      id: String(item.id ?? ""),
      name: String(item.name ?? name),
      webUrl: String(item.webUrl ?? ""),
    };
  }
}
