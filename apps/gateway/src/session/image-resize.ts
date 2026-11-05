import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IMAGE_MAX_EDGE, imageSize } from "@psyche/agent-core";

const run = promisify(execFile);

/**
 * Cuts an image's long edge to 1568 px (what providers resize to anyway) so it costs fewer
 * tokens and less bandwidth. macOS uses its own `sips`; Windows and Linux use `@napi-rs/canvas`
 * (Skia, prebuilt for win32/linux/darwin; loaded only when an image needs it). The output keeps
 * the input's format (PNG, JPEG, WebP), so the caller's mime type stays right. GIFs, and any
 * failure (no prebuilt binary for this machine, an image Skia cannot decode), pass the original
 * bytes through unchanged (the estimator still charges by dimensions).
 */
export async function downscaleImage(
  bytes: Buffer,
  mime: string,
  maxEdge: number = IMAGE_MAX_EDGE,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer> {
  const size = imageSize(bytes);
  if (size === undefined || Math.max(size.width, size.height) <= maxEdge) return bytes;
  if (mime === "image/gif") return bytes;
  if (platform !== "darwin") return downscaleWithCanvas(bytes, mime, maxEdge, size);
  const dir = await mkdtemp(join(tmpdir(), "psyche-img-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "out");
    await writeFile(input, bytes);
    await run("/usr/bin/sips", ["-Z", String(maxEdge), input, "--out", output], {
      timeout: 15_000,
    });
    const out = await readFile(output);
    return out.length > 0 && out.length < bytes.length * 4 ? out : bytes;
  } catch {
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const CANVAS_FORMATS: Record<string, "png" | "jpeg" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
};

async function downscaleWithCanvas(
  bytes: Buffer,
  mime: string,
  maxEdge: number,
  size: { width: number; height: number },
): Promise<Buffer> {
  const format = CANVAS_FORMATS[mime];
  if (format === undefined) return bytes;
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(bytes);
    const scale = maxEdge / Math.max(size.width, size.height);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const out =
      format === "png"
        ? await canvas.encode("png")
        : format === "jpeg"
          ? await canvas.encode("jpeg", 85)
          : await canvas.encode("webp", 85);
    return out.length > 0 && out.length < bytes.length * 4 ? out : bytes;
  } catch {
    return bytes;
  }
}
