import { inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP reader for DOCX and XLSX: the central directory, then single entries inflated
 * with `node:zlib` under a hard output cap, so a zip bomb fails instead of filling memory.
 * Refuses ZIP64 and encrypted entries (Office documents need neither).
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const MAX_ENTRIES = 20_000;

export class ZipError extends Error {}

function u16(b: Uint8Array, at: number): number {
  if (at + 2 > b.byteLength) throw new ZipError("truncated ZIP");
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
}

/** The entries of a ZIP archive by name. */
export function readZip(buf: Uint8Array): Map<string, ZipEntry> {
  // End of central directory: 22 bytes plus a comment of up to 65,535 bytes.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a ZIP archive");
  const count = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 is not supported");
  if (count > MAX_ENTRIES) throw new ZipError(`more than ${MAX_ENTRIES} ZIP entries`);
  const entries = new Map<string, ZipEntry>();
  const names = new TextDecoder("utf-8");
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(buf, at) !== 0x02014b50) throw new ZipError("corrupt ZIP central directory");
    const flags = u16(buf, at + 8);
    const nameLen = u16(buf, at + 28);
    const end = at + 46 + nameLen;
    if (end > buf.byteLength) throw new ZipError("truncated ZIP");
    const entry: ZipEntry = {
      name: names.decode(buf.subarray(at + 46, end)),
      method: u16(buf, at + 10),
      compressedSize: u32(buf, at + 20),
      size: u32(buf, at + 24),
      localOffset: u32(buf, at + 42),
    };
    if ((flags & 1) === 0) entries.set(entry.name, entry);
    at = end + u16(buf, at + 30) + u16(buf, at + 32);
  }
  return entries;
}

/** One entry's bytes, refusing more than `cap` bytes of output whatever the header claims. */
export function inflateEntry(buf: Uint8Array, entry: ZipEntry, cap: number): Uint8Array {
  if (entry.size > cap) throw new ZipError(`a ZIP part expands beyond ${cap} bytes`);
  const at = entry.localOffset;
  if (u32(buf, at) !== 0x04034b50) throw new ZipError("corrupt ZIP entry");
  const start = at + 30 + u16(buf, at + 26) + u16(buf, at + 28);
  const end = start + entry.compressedSize;
  if (end > buf.byteLength) throw new ZipError("truncated ZIP");
  const data = buf.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ZipError(`unsupported ZIP compression ${entry.method}`);
  try {
    return inflateRawSync(data, { maxOutputLength: cap });
  } catch (err) {
    if (err instanceof RangeError || (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new ZipError(`a ZIP part expands beyond ${cap} bytes`);
    throw new ZipError("corrupt ZIP entry");
  }
}
