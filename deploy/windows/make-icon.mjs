// Renders the Windows icons from the master app icon (apps/desktop/assets/icon.png, 1024 px, made
// by deploy/macos/make-icon.mjs):
//   apps/desktop/assets/icon.ico   Psyche.exe, Setup.exe and the shortcuts: 16–256 px
//   apps/desktop/assets/tray.ico   the notification-area icon: 16–64 px (every DPI step)
// The .ico files are committed; run this only after changing the icon.
//   node deploy/windows/make-icon.mjs
// Uses @napi-rs/canvas from the workspace store (like make-icon.mjs); runs on any OS. Every frame is
// a PNG inside the ICO container, which Windows reads at every size since Vista.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** ICO container (ICONDIR + ICONDIRENTRY[] + PNG payloads) for `[size, png]` frames. */
export function icoFromPngs(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + 16 * frames.length;
  for (const [size, png] of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // no palette
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map(([, png]) => png)]);
}

/** Sizes and PNG lengths of an ICO file's frames, for checks. */
export function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an .ico");
  const n = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const at = 6 + 16 * i;
    const size = buf.readUInt8(at) || 256;
    const length = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const png = buf.subarray(offset, offset + length);
    if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`frame ${size}: not a PNG`);
    frames.push({ size, length });
  }
  return frames;
}

function canvasModule() {
  const store = join(ROOT, "node_modules/.pnpm");
  const dir = readdirSync(store).find((d) => d.startsWith("@napi-rs+canvas@"));
  if (!dir) throw new Error("@napi-rs/canvas is not installed (pnpm install)");
  return createRequire(join(store, dir, "node_modules/@napi-rs/canvas/package.json"))(
    "@napi-rs/canvas",
  );
}

async function main() {
  const { createCanvas, loadImage } = canvasModule();
  const assets = join(ROOT, "apps/desktop/assets");
  const master = await loadImage(readFileSync(join(assets, "icon.png")));
  // The macOS grid leaves a 100 px margin around the 824 px tile; Windows icons fill more of the
  // square, so the app icon keeps a 40 px margin and the tray icon almost none.
  const frame = (size, margin) => {
    const c = createCanvas(size, size);
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const src = 1024 - 2 * margin;
    g.drawImage(master, margin, margin, src, src, 0, 0, size, size);
    return [size, c.toBuffer("image/png")];
  };
  const app = icoFromPngs([16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map((s) => frame(s, 60)));
  const tray = icoFromPngs([16, 20, 24, 32, 40, 48, 64].map((s) => frame(s, 92)));
  writeFileSync(join(assets, "icon.ico"), app);
  writeFileSync(join(assets, "tray.ico"), tray);
  process.stdout.write(
    `wrote apps/desktop/assets/icon.ico (${readIco(app).length} sizes) and tray.ico (${readIco(tray).length} sizes)\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`make-icon: ${err.message}\n`);
    process.exit(1);
  });
}
