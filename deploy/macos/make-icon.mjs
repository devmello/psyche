// Renders the Psyche app icon: apps/desktop/assets/icon.png (1024 px), the .iconset PNG sizes and
// apps/desktop/assets/icon.icns (via iconutil), plus apps/mac-helper/dist-assets/PsycheHelper.icns.
// The PNG and icns files are committed; run this only to change the icon.
//   node deploy/macos/make-icon.mjs
// Uses @napi-rs/canvas from the workspace store (a transitive dependency of the viewers), like
// make-background.mjs. macOS only for the icns step (iconutil).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const store = join(ROOT, "node_modules/.pnpm");
const dir = readdirSync(store).find((d) => d.startsWith("@napi-rs+canvas@"));
if (!dir) throw new Error("@napi-rs/canvas is not installed (pnpm install)");
const { createCanvas } = createRequire(
  join(store, dir, "node_modules/@napi-rs/canvas/package.json"),
)("@napi-rs/canvas");

const SIZE = 1024;

/** macOS icon grid: the squircle fills ~80% of the canvas with transparent margins. */
function squirclePath(g, x, y, w, h, r) {
  // Continuous-corner approximation (Apple's superellipse) with cubic curves.
  const k = 0.552284749831 * 0.92;
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.bezierCurveTo(x + w - r + r * k, y, x + w, y + r - r * k, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.bezierCurveTo(x + w, y + h - r + r * k, x + w - r + r * k, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.bezierCurveTo(x + r - r * k, y + h, x, y + h - r + r * k, x, y + h - r);
  g.lineTo(x, y + r);
  g.bezierCurveTo(x, y + r - r * k, x + r - r * k, y, x + r, y);
  g.closePath();
}

function render(size) {
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  const s = size / SIZE;
  g.scale(s, s);

  // Tile: the app's indigo accent, deeper at the bottom, with a soft highlight at the top.
  const inset = 100;
  const tile = SIZE - inset * 2;
  const radius = tile * 0.2237;
  squirclePath(g, inset, inset, tile, tile, radius);
  const base = g.createLinearGradient(0, inset, 0, inset + tile);
  base.addColorStop(0, "#7b6cf6");
  base.addColorStop(1, "#4a3bcf");
  g.fillStyle = base;
  g.fill();

  g.save();
  squirclePath(g, inset, inset, tile, tile, radius);
  g.clip();
  const glow = g.createRadialGradient(
    SIZE * 0.5,
    inset + tile * 0.18,
    40,
    SIZE * 0.5,
    inset + tile * 0.18,
    tile * 0.9,
  );
  glow.addColorStop(0, "rgba(255,255,255,0.28)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = glow;
  g.fillRect(inset, inset, tile, tile);
  // A faint ring of light near the bottom, like a lantern (the moth is the default creature).
  const lantern = g.createRadialGradient(
    SIZE * 0.5,
    inset + tile * 0.62,
    10,
    SIZE * 0.5,
    inset + tile * 0.62,
    tile * 0.42,
  );
  lantern.addColorStop(0, "rgba(255,230,160,0.22)");
  lantern.addColorStop(1, "rgba(255,230,160,0)");
  g.fillStyle = lantern;
  g.fillRect(inset, inset, tile, tile);
  g.restore();

  // The Psyche mark (packages/ui/src/brand.tsx): a ring and a psi, rounded strokes, in white.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const unit = tile / 32; // the mark's 32-unit grid
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = "rgba(255,255,255,0.96)";
  g.shadowColor = "rgba(30,20,90,0.35)";
  g.shadowBlur = 18;
  g.shadowOffsetY = 6;
  g.lineWidth = unit * 2.1;

  // Ring: r = 14 units in the 32 grid, drawn slightly smaller so the psi has air.
  g.beginPath();
  g.arc(cx, cy, unit * 12.6, 0, Math.PI * 2);
  g.stroke();

  // Psi: stem from (16,6) to (16,26); cup from (9,11) down to (16,19) up to (23,11).
  const px = (x) => cx + (x - 16) * unit * 0.9;
  const py = (y) => cy + (y - 16) * unit * 0.9;
  g.beginPath();
  g.moveTo(px(16), py(7));
  g.lineTo(px(16), py(25.5));
  g.stroke();
  g.beginPath();
  g.moveTo(px(9.5), py(11));
  g.bezierCurveTo(px(9.5), py(16.5), px(12.5), py(19.2), px(16), py(19.2));
  g.bezierCurveTo(px(19.5), py(19.2), px(22.5), py(16.5), px(22.5), py(11));
  g.stroke();

  return c;
}

const desktopAssets = join(ROOT, "apps/desktop/assets");
const helperAssets = join(ROOT, "apps/mac-helper/dist-assets");
mkdirSync(desktopAssets, { recursive: true });
mkdirSync(helperAssets, { recursive: true });

// Master PNG.
writeFileSync(join(desktopAssets, "icon.png"), render(SIZE).toBuffer("image/png"));

// Iconset for iconutil.
const iconset = join(ROOT, "out", "Psyche.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const base of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${base}x${base}.png`), render(base).toBuffer("image/png"));
  writeFileSync(
    join(iconset, `icon_${base}x${base}@2x.png`),
    render(base * 2).toBuffer("image/png"),
  );
}
if (process.platform === "darwin") {
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(desktopAssets, "icon.icns")]);
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(helperAssets, "PsycheHelper.icns")]);
  console.log(
    "wrote apps/desktop/assets/icon.{png,icns} and apps/mac-helper/dist-assets/PsycheHelper.icns",
  );
} else {
  console.log(
    "wrote apps/desktop/assets/icon.png and the iconset; run iconutil on macOS for the icns",
  );
}
