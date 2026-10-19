/**
 * Shared paint and small parts for the bundled creatures. Every color is a theme variable so the
 * creatures follow the accent and the light / dark appearance.
 */
import type { ReactElement, ReactNode } from "react";

export const PALE = "var(--gray-3)";
export const MID = "var(--gray-5)";
export const DEEP = "var(--gray-7)";
export const LINE = "var(--gray-12)";
export const GLINT = "var(--gray-1)";
export const ACCENT = "var(--accent-9)";
export const ACCENT_SOFT = "var(--accent-7)";
export const BLUSH = "var(--accent-4)";

/** The outline every creature shares. */
export const ink = {
  stroke: LINE,
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** A thinner line for details inside a silhouette (whiskers, veins, stripes). */
export const fine = { ...ink, strokeWidth: 1.4, fill: "none" } as const;

/** Rounds to two decimals so generated paths stay short. */
export function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function Eye({ cx, cy, r = 2.5 }: { cx: number; cy: number; r?: number }): ReactElement {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={LINE} />
      <circle cx={cx - r * 0.35} cy={cy - r * 0.38} r={r * 0.36} fill={GLINT} />
    </g>
  );
}

/** A pair of eyes mirrored around x = 32. */
export function Eyes({ dx, cy, r }: { dx: number; cy: number; r?: number }): ReactElement {
  return (
    <g>
      <Eye cx={32 - dx} cy={cy} r={r} />
      <Eye cx={32 + dx} cy={cy} r={r} />
    </g>
  );
}

/** A pair of blush marks mirrored around x = 32. */
export function Cheeks({
  dx,
  cy,
  rx = 2.6,
}: {
  dx: number;
  cy: number;
  rx?: number;
}): ReactElement {
  return (
    <g fill={BLUSH}>
      <ellipse cx={32 - dx} cy={cy} rx={rx} ry={rx * 0.62} />
      <ellipse cx={32 + dx} cy={cy} rx={rx} ry={rx * 0.62} />
    </g>
  );
}

export function Smile({
  cx = 32,
  cy,
  w = 5,
}: {
  cx?: number;
  cy: number;
  w?: number;
}): ReactElement {
  const h = w / 2;
  return (
    <path
      d={`M${n(cx - h)} ${n(cy)} Q${n(cx)} ${n(cy + w * 0.55)} ${n(cx + h)} ${n(cy)}`}
      {...ink}
      fill="none"
    />
  );
}

/** Draws `children` and their mirror image across the vertical center line. */
export function Mirrored({ children }: { children: ReactNode }): ReactElement {
  return (
    <g>
      {children}
      <g transform="matrix(-1 0 0 1 64 0)">{children}</g>
    </g>
  );
}

/** An outlined tube along `d` (tails, tentacles, stalks). */
export function Tube({ d, fill, width }: { d: string; fill: string; width: number }): ReactElement {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={LINE} strokeWidth={width + 4} />
      <path d={d} stroke={fill} strokeWidth={width} />
    </g>
  );
}
