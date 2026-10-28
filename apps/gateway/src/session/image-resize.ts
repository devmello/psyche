import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IMAGE_MAX_EDGE, imageSize } from "@psyche/agent-core";

const run = promisify(execFile);

/**
 * Cuts an image's long edge to 1568 px (what providers resize to anyway) so it costs fewer
 * tokens and less bandwidth. Uses macOS's `sips`; anywhere else, or on any failure, the original
 * bytes go through unchanged (the estimator still charges by dimensions).
 */
export async function downscaleImage(
  bytes: Buffer,
  mime: string,
  maxEdge: number = IMAGE_MAX_EDGE,
): Promise<Buffer> {
  const size = imageSize(bytes);
  if (size === undefined || Math.max(size.width, size.height) <= maxEdge) return bytes;
  if (process.platform !== "darwin" || mime === "image/gif") return bytes;
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
