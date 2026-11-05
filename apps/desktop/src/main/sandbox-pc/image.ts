import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

/**
 * The sandbox PC's guest image: `vmlinuz`, `initrd` and `rootfs.vhdx`, published as a manifest
 * plus one (zstd-compressed) file each, built by deploy/windows/guest-image. The manifest:
 *
 *   {
 *     "format": "psyche-windows-guest-image", "formatVersion": 1,
 *     "imageVersion": "2026.11.1",                 // the folder name under vm-images\
 *     "guestOS": "Debian 13", "arch": "x64",
 *     "files": [{
 *       "name": "rootfs.vhdx",                     // vmlinuz | initrd | rootfs.vhdx
 *       "url": "https://…/rootfs.vhdx.zst",        // https only
 *       "bytes": 2147483648,                       // size of the unpacked file
 *       "sha256": "<hex>",                         // of the unpacked file
 *       "compressed": { "codec": "zstd", "bytes": 612345678, "sha256": "<hex>" }   // optional
 *     }]
 *   }
 *
 * Every file is hashed while it downloads and unpacks, and moved into place only when the digests
 * match; `manifest.json` is written last, so a folder holding it is a complete, verified image. The
 * service checks the same digests again before it boots anything. The folder
 * (`%LOCALAPPDATA%\Psyche\vm-images\<imageVersion>\`) is limited to the owner and SYSTEM by the
 * caller (`restrictTo`).
 */

export const IMAGE_FORMAT = "psyche-windows-guest-image";
export const IMAGE_FILES = ["vmlinuz", "initrd", "rootfs.vhdx"] as const;
export type ImageFileName = (typeof IMAGE_FILES)[number];

export interface GuestImageFile {
  name: ImageFileName;
  url: string;
  bytes: number;
  sha256: string;
  compressed?: { codec: "zstd"; bytes: number; sha256: string };
}

export interface GuestImageManifest {
  format: typeof IMAGE_FORMAT;
  formatVersion: 1;
  imageVersion: string;
  guestOS: string;
  arch: "x64" | "arm64";
  files: GuestImageFile[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ImageErrorReason =
  | "manifest_invalid"
  | "download_failed"
  | "digest_mismatch"
  | "no_space"
  | "cancelled";

export class ImageError extends Error {
  readonly reason: ImageErrorReason;
  constructor(reason: ImageErrorReason, message: string) {
    super(message);
    this.name = "ImageError";
    this.reason = reason;
  }
}

/** Validates a manifest from the network: shape, digests, https URLs, no path in a file name. */
export function parseManifest(text: string): GuestImageManifest {
  const bad = (m: string): never => {
    throw new ImageError("manifest_invalid", `The guest image manifest is not usable: ${m}`);
  };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return bad("not JSON");
  }
  if (v === null || typeof v !== "object") return bad("not an object");
  if (v.format !== IMAGE_FORMAT || v.formatVersion !== 1) return bad("unknown format");
  if (typeof v.imageVersion !== "string" || !VERSION.test(v.imageVersion))
    return bad("imageVersion");
  if (typeof v.guestOS !== "string" || v.guestOS.length > 100) return bad("guestOS");
  if (v.arch !== "x64" && v.arch !== "arm64") return bad("arch");
  if (!Array.isArray(v.files)) return bad("files");
  const files: GuestImageFile[] = [];
  for (const raw of v.files as Record<string, unknown>[]) {
    const name = raw?.name;
    if (!(IMAGE_FILES as readonly unknown[]).includes(name)) return bad("file name");
    if (files.some((f) => f.name === name)) return bad("duplicate file");
    if (typeof raw.url !== "string" || !/^https:\/\/[^\s]+$/.test(raw.url)) return bad("url");
    if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) <= 0) return bad("bytes");
    if (typeof raw.sha256 !== "string" || !HEX64.test(raw.sha256)) return bad("sha256");
    const file: GuestImageFile = {
      name: name as ImageFileName,
      url: raw.url,
      bytes: raw.bytes as number,
      sha256: raw.sha256,
    };
    const c = raw.compressed as Record<string, unknown> | undefined;
    if (c !== undefined) {
      if (
        c.codec !== "zstd" ||
        !Number.isSafeInteger(c.bytes) ||
        (c.bytes as number) <= 0 ||
        typeof c.sha256 !== "string" ||
        !HEX64.test(c.sha256)
      )
        return bad("compressed");
      file.compressed = { codec: "zstd", bytes: c.bytes as number, sha256: c.sha256 };
    }
    files.push(file);
  }
  for (const need of IMAGE_FILES) if (!files.some((f) => f.name === need)) return bad(`no ${need}`);
  return {
    format: IMAGE_FORMAT,
    formatVersion: 1,
    imageVersion: v.imageVersion,
    guestOS: v.guestOS,
    arch: v.arch,
    files,
  };
}

/** Bytes to download for this image, and bytes the unpacked files take on disk. */
export function imageSizes(m: GuestImageManifest): { download: number; disk: number } {
  return {
    download: m.files.reduce((n, f) => n + (f.compressed?.bytes ?? f.bytes), 0),
    disk: m.files.reduce((n, f) => n + f.bytes, 0),
  };
}

export interface DownloadProgress {
  stage: "download" | "verify";
  /** Compressed bytes received so far, over all files. */
  receivedBytes: number;
  totalBytes: number;
  file: ImageFileName;
}

export interface DownloadOptions {
  dir: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Free bytes on the drive holding `dir` (default: statfs). */
  freeBytes?: (dir: string) => number;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function freeBytesOf(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Downloads, unpacks and verifies the image into `dir`. Files already there with the right digest
 * are kept (a retry after a failure or a cancel resumes at the first missing file).
 */
export async function downloadImage(
  m: GuestImageManifest,
  manifestText: string,
  opts: DownloadOptions,
): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  mkdirSync(opts.dir, { recursive: true });
  const need = imageSizes(m).disk;
  const free = (opts.freeBytes ?? freeBytesOf)(opts.dir);
  if (free < need + 256 * 1024 * 1024) {
    throw new ImageError(
      "no_space",
      `The guest image needs about ${Math.ceil(need / 1e9)} GB of free disk space`,
    );
  }
  const total = imageSizes(m).download;
  let done = 0;
  for (const f of m.files) {
    const final = join(opts.dir, f.name);
    const part = `${final}.part`;
    const size = f.compressed?.bytes ?? f.bytes;
    if (existsSync(final) && statSync(final).size === f.bytes && sha256File(final) === f.sha256) {
      done += size;
      opts.onProgress?.({
        stage: "download",
        receivedBytes: done,
        totalBytes: total,
        file: f.name,
      });
      continue;
    }
    if (opts.signal?.aborted) throw new ImageError("cancelled", "Cancelled");
    let res: Response;
    try {
      res = await doFetch(f.url, { signal: opts.signal ?? null, redirect: "follow" });
    } catch (err) {
      if (opts.signal?.aborted) throw new ImageError("cancelled", "Cancelled");
      throw new ImageError("download_failed", `Could not reach the guest image (${errText(err)})`);
    }
    if (!res.ok || res.body === null) {
      throw new ImageError("download_failed", `The guest image server answered ${res.status}`);
    }
    const wire = createHash("sha256");
    const unpacked = createHash("sha256");
    let received = 0;
    let written = 0;
    const base = done;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        wire.update(chunk);
        received += chunk.length;
        opts.onProgress?.({
          stage: "download",
          receivedBytes: base + Math.min(received, size),
          totalBytes: total,
          file: f.name,
        });
        cb(null, chunk);
      },
    });
    const tally = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        unpacked.update(chunk);
        written += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      const source = Readable.fromWeb(res.body as never);
      const out = createWriteStream(part, { flags: "w" });
      if (f.compressed) {
        await pipeline(source, count, createZstdDecompress(), tally, out, {
          signal: opts.signal as AbortSignal,
        });
      } else {
        await pipeline(source, count, tally, out, { signal: opts.signal as AbortSignal });
      }
    } catch (err) {
      rmSync(part, { force: true });
      if (opts.signal?.aborted) throw new ImageError("cancelled", "Cancelled");
      throw new ImageError("download_failed", `The guest image download failed (${errText(err)})`);
    }
    opts.onProgress?.({
      stage: "verify",
      receivedBytes: base + size,
      totalBytes: total,
      file: f.name,
    });
    if (
      (f.compressed &&
        (wire.digest("hex") !== f.compressed.sha256 || received !== f.compressed.bytes)) ||
      unpacked.digest("hex") !== f.sha256 ||
      written !== f.bytes
    ) {
      rmSync(part, { force: true });
      throw new ImageError(
        "digest_mismatch",
        `${f.name} does not match the published checksum; it was discarded`,
      );
    }
    rmSync(final, { force: true });
    renameSync(part, final);
    done += size;
  }
  // Last: a folder with a manifest is a complete image.
  const tmp = join(opts.dir, "manifest.json.part");
  writeFileSync(tmp, manifestText);
  renameSync(tmp, join(opts.dir, "manifest.json"));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The newest complete image on disk (folders holding a `manifest.json`), by folder name. */
export function installedImageVersion(
  imagesRoot: string,
  ls: (dir: string) => string[],
): string | null {
  let names: string[];
  try {
    names = ls(imagesRoot);
  } catch {
    return null;
  }
  const have = names
    .filter((n) => VERSION.test(n) && existsSync(join(imagesRoot, n, "manifest.json")))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return have.at(-1) ?? null;
}
