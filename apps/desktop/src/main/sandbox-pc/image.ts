import { createHash } from "node:crypto";
import {
  createReadStream,
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
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

/**
 * The sandbox PC's guest image, built and published by deploy/windows/guest-image (release
 * `windows-guest-image-v<imageVersion>`): `vmlinuz`, `initrd`, `rootfs.vhdx.zst` (the root disk,
 * zstd), `sessiondata.vhdx` (a template the service formats itself: not downloaded) and
 * `manifest.json`:
 *
 *   {
 *     "schema": 1, "kind": "psyche-windows-guest-image", "imageVersion": "0.1.0-84ef34a6",
 *     "arch": "x86_64",
 *     "files": {
 *       "vmlinuz": { "name", "size", "sha256" },
 *       "initrd": { "name", "size", "sha256" },
 *       "rootfs": { "name": "rootfs.vhdx", "size", "sha256",
 *                   "compressed": { "name": "rootfs.vhdx.zst", "size", "sha256", "format": "zstd" } }
 *     }, …
 *   }
 *
 * Sizes and digests of a compressed file describe the unpacked file, and `compressed` the
 * download. Every file is hashed while it downloads and unpacks, and moved into place only when
 * the digests match; `manifest.json` (verbatim: the service pins it) is written last, so a folder
 * holding it is a complete, verified image. The folder
 * (`%LOCALAPPDATA%\Psyche\vm-images\<imageVersion>\`) is limited to the owner and SYSTEM by the
 * caller.
 */

export const IMAGE_KIND = "psyche-windows-guest-image";
export const IMAGE_FILES = ["vmlinuz", "initrd", "rootfs.vhdx"] as const;
export type ImageFileName = (typeof IMAGE_FILES)[number];

export interface GuestImageFile {
  name: ImageFileName;
  /** The file to fetch from the source: `name`, or the compressed file's name. */
  asset: string;
  bytes: number;
  sha256: string;
  compressed?: { bytes: number; sha256: string };
}

export interface GuestImageManifest {
  imageVersion: string;
  arch: string;
  files: GuestImageFile[];
}

/** Where the files come from: a release (HTTPS) or a local folder (development). */
export type ImageSource = (asset: string, signal?: AbortSignal) => Promise<Readable>;

export function httpSource(baseUrl: string, doFetch: typeof fetch = fetch): ImageSource {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return async (asset, signal) => {
    let res: Response;
    try {
      res = await doFetch(new URL(asset, base).toString(), {
        signal: signal ?? null,
        redirect: "follow",
      });
    } catch (err) {
      if (signal?.aborted) throw new ImageError("cancelled", "Cancelled");
      throw new ImageError("download_failed", `Could not reach the guest image (${errText(err)})`);
    }
    if (!res.ok || res.body === null) {
      throw new ImageError("download_failed", `The guest image server answered ${res.status}`);
    }
    return Readable.fromWeb(res.body as never);
  };
}

/** A local build (`PSYCHE_VM_IMAGE_DIR`, unpackaged runs only): the same files in a folder. */
export function folderSource(dir: string): ImageSource {
  return async (asset) => {
    if (asset !== basename(asset)) throw new ImageError("manifest_invalid", "bad file name");
    const path = join(dir, asset);
    if (!existsSync(path)) {
      throw new ImageError("download_failed", `${asset} is not in ${dir}`);
    }
    return createReadStream(path);
  };
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

/** Validates a manifest from the network: shape, digests, no path in a file name. */
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
  if (v.kind !== IMAGE_KIND || v.schema !== 1) return bad("unknown format");
  if (typeof v.imageVersion !== "string" || !VERSION.test(v.imageVersion))
    return bad("imageVersion");
  if (typeof v.arch !== "string" || !["x86_64", "x64"].includes(v.arch)) return bad("arch");
  const raw = v.files as Record<string, Record<string, unknown>> | undefined;
  if (raw === null || typeof raw !== "object") return bad("files");
  const hex = (x: unknown) => typeof x === "string" && HEX64.test(x);
  const size = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;
  const assetName = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(x);
  const files: GuestImageFile[] = [];
  for (const [key, name] of [
    ["vmlinuz", "vmlinuz"],
    ["initrd", "initrd"],
    ["rootfs", "rootfs.vhdx"],
  ] as const) {
    const f = raw[key];
    if (f === undefined || f.name !== name || !size(f.size) || !hex(f.sha256)) return bad(key);
    const file: GuestImageFile = {
      name,
      asset: name,
      bytes: f.size as number,
      sha256: f.sha256 as string,
    };
    const c = f.compressed as Record<string, unknown> | undefined;
    if (c !== undefined) {
      if (c.format !== "zstd" || !assetName(c.name) || !size(c.size) || !hex(c.sha256))
        return bad(`${key} compressed`);
      file.asset = c.name as string;
      file.compressed = { bytes: c.size as number, sha256: c.sha256 as string };
    }
    files.push(file);
  }
  return { imageVersion: v.imageVersion, arch: v.arch, files };
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
  source: ImageSource;
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
    const source = await opts.source(f.asset, opts.signal);
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
