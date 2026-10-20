import type { MethodName, MethodParams, MethodResult } from "@psyche/protocol";

/**
 * Whole-file reads over the chunked `files.read` and `documents.convert` (feature P4): the
 * viewers get one `Uint8Array`, the Gateway never sends a frame over the 1 MiB limit.
 */

export type GatewayCall = <M extends MethodName>(
  method: M,
  params: MethodParams<M>,
) => Promise<MethodResult<M>>;

/** A file the Gateway can read: an absolute path in a granted folder, or a Library path. */
export type FileSource = { path: string } | { libraryPath: string };

/** Previews stop here: a viewer holds the whole file in memory. */
export const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return at === size ? out : out.subarray(0, at);
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export interface ReadFileResult {
  bytes: Uint8Array;
  name: string;
  mime: string;
  etag: string;
}

/** Reads a whole file chunk by chunk; fails if it changes between chunks or is too large. */
export async function readFileBytes(
  call: GatewayCall,
  source: FileSource,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<ReadFileResult> {
  const max = options.maxBytes ?? PREVIEW_MAX_BYTES;
  const parts: Uint8Array[] = [];
  let first: MethodResult<"files.read"> | undefined;
  let offset = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const r = await call("files.read", { ...source, offset });
    if (first === undefined) {
      if (r.size > max) {
        throw new Error(`${r.name} is ${mb(r.size)}; previews stop at ${mb(max)}.`);
      }
      first = r;
    } else if (r.etag !== first.etag) {
      throw new Error(`${r.name} changed while it was loading. Open it again.`);
    }
    parts.push(fromBase64(r.bytes));
    if (r.nextOffset == null) break;
    offset = r.nextOffset;
  }
  return { bytes: concat(parts, first.size), name: first.name, mime: first.mime, etag: first.etag };
}

/** Converts a file with the Gateway's LibreOffice and reads the whole result. */
export async function convertFileBytes(
  call: GatewayCall,
  source: FileSource,
  target: "pdf" | "thumbnail",
  options: { signal?: AbortSignal } = {},
): Promise<{ bytes: Uint8Array; mime: "application/pdf" | "image/png" }> {
  const parts: Uint8Array[] = [];
  let size = 0;
  let mime: "application/pdf" | "image/png" = "application/pdf";
  let offset = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const r = await call("documents.convert", { ...source, target, offset });
    size = r.size;
    mime = r.mime;
    parts.push(fromBase64(r.bytes));
    if (r.nextOffset == null) break;
    offset = r.nextOffset;
  }
  return { bytes: concat(parts, size), mime };
}
