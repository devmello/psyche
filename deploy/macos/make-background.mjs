// Regenerates deploy/macos/dmg-background.png (the DMG window: Psyche on the left, Applications on
// the right, an arrow and one line of text). The PNG is committed; run this only to change it.
//   node deploy/macos/make-background.mjs
// Uses @napi-rs/canvas from the workspace store (a transitive dependency of the viewers).
import { readdirSync, writeFileSync } from "node:fs";
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

// Window content area 660 x 400 at 2x for Retina; Finder scales it.
const W = 660;
const H = 400;
const S = 2;
const c = createCanvas(W * S, H * S);
const g = c.getContext("2d");
g.scale(S, S);
const bg = g.createLinearGradient(0, 0, 0, H);
bg.addColorStop(0, "#f7f6f2");
bg.addColorStop(1, "#ecebe6");
g.fillStyle = bg;
g.fillRect(0, 0, W, H);

// Arrow from the app icon (x 180) to Applications (x 480), at icon height (y 190).
g.strokeStyle = "#8a8780";
g.fillStyle = "#8a8780";
g.lineWidth = 3;
g.lineCap = "round";
g.beginPath();
g.moveTo(255, 190);
g.lineTo(395, 190);
g.stroke();
g.beginPath();
g.moveTo(405, 190);
g.lineTo(390, 181);
g.lineTo(390, 199);
g.closePath();
g.fill();

g.fillStyle = "#4a4843";
g.font = "500 15px -apple-system, 'Helvetica Neue', Arial, sans-serif";
g.textAlign = "center";
g.fillText("Drag Psyche to Applications to install", W / 2, 330);
g.fillStyle = "#8a8780";
g.font = "12px -apple-system, 'Helvetica Neue', Arial, sans-serif";
g.fillText("Unsigned build? Open it once from System Settings › Privacy & Security.", W / 2, 352);

writeFileSync(join(ROOT, "deploy/macos/dmg-background.png"), c.toBuffer("image/png"));
// 144 dpi, so Finder lays the 2x image out at 660 x 400 points.
const { execFileSync } = await import("node:child_process");
execFileSync("sips", [
  "-s",
  "dpiWidth",
  "144",
  "-s",
  "dpiHeight",
  "144",
  join(ROOT, "deploy/macos/dmg-background.png"),
]);
process.stdout.write("wrote deploy/macos/dmg-background.png\n");
