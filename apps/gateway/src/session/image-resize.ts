import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IMAGE_MAX_EDGE, imageSize, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE_PX } from "@psyche/agent-core";

const run = promisify(execFile);

/**
 * Cuts an image's long edge to 1568 px (what providers resize to anyway) so it costs fewer
 * tokens and less bandwidth. Each desktop OS uses its own imaging stack, so the desktop bundles
 * carry no image library: macOS runs `sips`, Windows runs WIC through Windows PowerShell's WPF
 * imaging classes. Linux servers use `@napi-rs/canvas` (Skia; loaded only when an image needs
 * it; the desktop bundles drop it, see `DROP_PACKAGES` in deploy/scripts/build-psyched.mjs). The
 * output keeps the input's format, so the caller's mime type stays right. GIFs, formats an OS
 * tool cannot write (WebP on Windows), and any failure pass the original bytes through unchanged
 * (the estimator still charges by dimensions).
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
  if (platform === "win32") return downscaleWithWic(bytes, mime, maxEdge);
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

/**
 * A tool's image (a screenshot, an MCP server's picture: untrusted bytes) decoded and written
 * again, its long edge cut to `maxEdge`: JPEG stays JPEG, everything else becomes PNG. Unlike
 * `downscaleImage` it never hands back the input. It throws when the image cannot be decoded or
 * no encoder is available (a Linux Gateway without `@napi-rs/canvas`), and the caller then sends
 * a note instead. A header over 8000 px or 40 MP is refused before any decoder runs, and the
 * header is parsed strictly (`imageSize`), so the decoder never sees a decompression bomb.
 */
export async function reencodeToolImage(
  bytes: Buffer,
  mime: string,
  maxEdge: number = IMAGE_MAX_EDGE,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer> {
  const size = imageSize(bytes);
  if (size === undefined) throw new Error("unreadable image header");
  // The caller checks too; a decoder never runs on an oversized header whoever calls this.
  if (overCaps(size)) throw new Error("image too large to decode");
  const format = mime === "image/jpeg" ? "jpeg" : "png";
  const edge = Math.min(maxEdge, Math.max(size.width, size.height));
  if (platform === "win32") return wicReencode(bytes, edge, format);
  if (platform !== "darwin") return canvasReencode(bytes, edge, format, size);
  const dir = await mkdtemp(join(tmpdir(), "psyche-img-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, `out.${format === "jpeg" ? "jpg" : "png"}`);
    await writeFile(input, bytes);
    // sips exits 0 and writes nothing for an input it skips ("not a valid file"): the read decides.
    await run(
      "/usr/bin/sips",
      ["-s", "format", format, "-Z", String(edge), input, "--out", output],
      {
        timeout: 15_000,
      },
    );
    const out = await readFile(output);
    if (out.length === 0) throw new Error("empty image");
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const overCaps = (s: { width: number; height: number }) =>
  s.width > MAX_IMAGE_SIDE_PX ||
  s.height > MAX_IMAGE_SIDE_PX ||
  s.width * s.height > MAX_IMAGE_PIXELS;

async function canvasReencode(
  bytes: Buffer,
  edge: number,
  format: "png" | "jpeg",
  size: { width: number; height: number },
): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  // Skia decodes the whole bitmap when the image loads (no header-only read), so the strict
  // header parse above is the gate; a decoded size that differs from it is refused all the same.
  const image = await loadImage(bytes);
  if (image.width !== size.width || image.height !== size.height || overCaps(image))
    throw new Error("decoded size differs from the header");
  const scale = edge / Math.max(size.width, size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const out = format === "png" ? await canvas.encode("png") : await canvas.encode("jpeg", 85);
  if (out.length === 0) throw new Error("empty image");
  return out;
}

async function wicReencode(bytes: Buffer, edge: number, format: "png" | "jpeg"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "psyche-img-"));
  try {
    const out = await runWic(dir, bytes, edge, format);
    if (out.length === 0) throw new Error("empty image");
    return out;
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

/**
 * Windows' counterpart of `sips`: WIC, through the WPF imaging classes in Windows PowerShell 5.1
 * (present on every Windows 10/11; `pwsh` is not assumed). Bytes go through files in a private
 * temp folder; the script takes paths and numbers only, so no image data reaches a command line.
 * WIC has no WebP encoder, so WebP passes through unchanged.
 */
const WIC_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$inPath, $outPath, $maxEdge, $kind = $args
$in = [IO.File]::OpenRead($inPath)
try {
  $dec = [Windows.Media.Imaging.BitmapDecoder]::Create($in, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
} finally { $in.Dispose() }
$frame = $dec.Frames[0]
$scale = [double]$maxEdge / [Math]::Max($frame.PixelWidth, $frame.PixelHeight)
$scaled = New-Object Windows.Media.Imaging.TransformedBitmap($frame, (New-Object Windows.Media.ScaleTransform($scale, $scale)))
if ($kind -eq 'png') { $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder }
else { $enc = New-Object Windows.Media.Imaging.JpegBitmapEncoder; $enc.QualityLevel = 85 }
$enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($scaled))
$out = [IO.File]::Create($outPath)
try { $enc.Save($out) } finally { $out.Dispose() }
`;

const WIC_FORMATS: Record<string, "png" | "jpeg"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
};

export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function downscaleWithWic(bytes: Buffer, mime: string, maxEdge: number): Promise<Buffer> {
  const kind = WIC_FORMATS[mime];
  if (kind === undefined) return bytes;
  const dir = await mkdtemp(join(tmpdir(), "psyche-img-"));
  try {
    const out = await runWic(dir, bytes, maxEdge, kind);
    return out.length > 0 && out.length < bytes.length * 4 ? out : bytes;
  } catch {
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs the WIC script in `dir` (a fresh private temp folder); the output file's bytes. */
async function runWic(
  dir: string,
  bytes: Buffer,
  maxEdge: number,
  kind: "png" | "jpeg",
): Promise<Buffer> {
  const input = join(dir, "in");
  const output = join(dir, "out");
  const script = join(dir, "resize.ps1");
  await writeFile(input, bytes);
  await writeFile(script, WIC_SCRIPT, "utf8");
  await run(
    windowsPowerShell(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      input,
      output,
      String(maxEdge),
      kind,
    ],
    { timeout: 20_000, windowsHide: true },
  );
  return readFile(output);
}
