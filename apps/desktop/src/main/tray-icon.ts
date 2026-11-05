/**
 * The Windows notification-area icon: Psyche's mark (the ψ in its ring, assets/icon.png) as a
 * monochrome glyph, the way Windows 11's own tray icons are drawn, in white on a dark taskbar and
 * near-black on a light one. It is rasterized here (anti-aliased strokes over a few line
 * segments) at every size Windows asks for across DPI scales, so no image file has to be packaged
 * and every scale is crisp. A pending approval adds an accent dot, like an unread badge.
 *
 * Pure (no Electron), so tests read the pixels.
 */

/** Tray icon sizes: 16 px at 100 % up to 32 px at 200 % (Windows picks the nearest). */
export const TRAY_ICON_SIZES = [16, 20, 24, 32] as const;

/** Glyph colours: white on a dark taskbar, Windows' near-black on a light one. */
export const TRAY_GLYPH = { onDark: [255, 255, 255], onLight: [28, 28, 28] } as const;
/** The badge: the app's accent (assets/icon.png's violet). */
export const TRAY_BADGE: readonly [number, number, number] = [124, 92, 255];

type Seg = readonly [number, number, number, number];

/** The mark in unit coordinates (ring centre 0.5, 0.5), from the 1024 px icon's geometry. */
function markSegments(): Seg[] {
  const segs: Seg[] = [];
  const ring = 0.41;
  const n = 48;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    segs.push([
      0.5 + ring * Math.cos(a0),
      0.5 + ring * Math.sin(a0),
      0.5 + ring * Math.cos(a1),
      0.5 + ring * Math.sin(a1),
    ]);
  }
  // The stem.
  segs.push([0.5, 0.235, 0.5, 0.775]);
  // The cup: two arms from y 0.36 bending into a half ellipse that bottoms out at y 0.6.
  const rx = 0.185;
  const top = 0.36;
  const ry = 0.24;
  const m = 16;
  let px = 0.5 - rx;
  let py = top;
  for (let i = 1; i <= m; i++) {
    const t = Math.PI - (i / m) * Math.PI;
    const x = 0.5 + rx * Math.cos(t);
    const y = top + ry * Math.sin(t);
    segs.push([px, py, x, y]);
    px = x;
    py = y;
  }
  return segs;
}

const SEGMENTS = markSegments();

function distToSeg(x: number, y: number, s: Seg): number {
  const [ax, ay, bx, by] = s;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * The glyph at `size` px as straight RGBA (top-left first). `badge` puts the accent dot in the
 * top-right corner, cut out of the glyph so it reads at 16 px.
 */
export function trayIconRgba(
  size: number,
  o: { dark: boolean; badge?: boolean },
): { width: number; height: number; rgba: Buffer } {
  const rgba = Buffer.alloc(size * size * 4);
  const [r, g, b]: readonly number[] = o.dark ? TRAY_GLYPH.onDark : TRAY_GLYPH.onLight;
  // Strokes at least 1.4 px wide, or the ring vanishes at 16 px; ~13 % of the size otherwise.
  const half = Math.max(1.4, size * 0.13) / 2;
  const badgeR = size * 0.2;
  const bx = size - badgeR - 0.5;
  const by = badgeR + 0.5;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      let d = Number.POSITIVE_INFINITY;
      for (const s of SEGMENTS) {
        d = Math.min(d, distToSeg(x / size, y / size, s) * size);
      }
      let a = Math.max(0, Math.min(1, half - d + 0.5));
      let cr = r;
      let cg = g;
      let cb = b;
      if (o.badge) {
        const bd = Math.hypot(x - bx, y - by);
        // A 1 px gap around the dot keeps it apart from the ring.
        const gap = Math.max(0, Math.min(1, bd - badgeR - 0.5));
        a *= gap;
        const dot = Math.max(0, Math.min(1, badgeR - bd + 0.5));
        if (dot > 0) {
          cr = TRAY_BADGE[0];
          cg = TRAY_BADGE[1];
          cb = TRAY_BADGE[2];
          a = Math.max(a, dot);
        }
      }
      const i = (py * size + px) * 4;
      rgba[i] = cr;
      rgba[i + 1] = cg;
      rgba[i + 2] = cb;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return { width: size, height: size, rgba };
}

/** RGBA → the BGRA `nativeImage.createFromBitmap` takes (premultiplied, as Skia expects). */
export function toBgraPremultiplied(rgba: Buffer): Buffer {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = (rgba[i + 3] as number) / 255;
    out[i] = Math.round((rgba[i + 2] as number) * a);
    out[i + 1] = Math.round((rgba[i + 1] as number) * a);
    out[i + 2] = Math.round((rgba[i] as number) * a);
    out[i + 3] = rgba[i + 3] as number;
  }
  return out;
}

/**
 * Whether the Windows taskbar is dark: `SystemUsesLightTheme` under Personalize (the taskbar's
 * own setting, apart from the apps' light/dark mode that `nativeTheme` follows). Reads the
 * output of `reg query …\Themes\Personalize /v SystemUsesLightTheme`; dark when unreadable,
 * Windows 11's default.
 */
export function taskbarIsDark(regOutput: string | undefined): boolean {
  const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput ?? "");
  return m ? Number.parseInt(m[1] as string, 16) === 0 : true;
}

/**
 * Windows "Transparency effects" (`EnableTransparency` under Personalize, from `reg query` of
 * the key); on when unreadable, Windows' default.
 */
export function transparencyEffects(regOutput: string | undefined): boolean {
  const m = /EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput ?? "");
  return m ? Number.parseInt(m[1] as string, 16) !== 0 : true;
}

export const PERSONALIZE_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
