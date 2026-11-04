import type { ReactElement } from "react";
import { encode } from "uqr";
import { cn } from "../lib/utils.ts";

/**
 * A QR code of `value`, drawn here as one SVG path: no network, no image service, nothing leaves
 * the window (a pairing link holds a one-time token). Error correction M; the quiet zone is four
 * modules, as scanners expect. It is dark on white whatever the theme, since a scanner reads
 * contrast, not our palette.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  /** What a screen reader says for the image. */
  label: string;
  className?: string;
}): ReactElement | null {
  let matrix: boolean[][];
  try {
    matrix = encode(value, { ecc: "M", border: 0 }).data;
  } catch {
    // Too long for any QR version: show nothing rather than a wrong code.
    return null;
  }
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  let path = "";
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== true) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === true) x += 1;
      path += `M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`;
    }
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn("size-48 rounded-md bg-white", className)}
      data-testid="qr-code"
    >
      <title>{label}</title>
      <path d={path} fill="#111111" />
    </svg>
  );
}
