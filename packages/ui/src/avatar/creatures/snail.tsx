import type { ReactElement } from "react";
import { AtLaptop } from "./laptop.tsx";
import { ACCENT, ACCENT_SOFT, BLUSH, Eye, fine, ink, LINE, MID, n, PALE, Smile } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

const SHELL = { cx: 25, cy: 32, r: 15 } as const;

/** An Archimedean spiral from the shell's center out to its rim. */
function spiral(): string {
  const end = Math.PI * 3.5;
  const growth = (SHELL.r - 1) / end;
  const points: string[] = [];
  for (let t = 0; t <= end + 0.001; t += 0.25) {
    const r = 1 + growth * t;
    points.push(
      `${n(SHELL.cx + r * Math.cos(t + Math.PI))} ${n(SHELL.cy + r * Math.sin(t + Math.PI))}`,
    );
  }
  return `M${points.join(" L")}`;
}

const SPIRAL = spiral();

const FOOT =
  "M5 52 C5 48 11 46.5 21 46.5 H40 C44.5 46.5 46 43 46 37 C46 28 48.5 22.5 53.5 22.5 C58.5 22.5 60 28 60 34 V50 C60 54 58 56 54 56 H9 C6.5 56 5 54.5 5 52 Z";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      {/* eye stalks */}
      <path
        d="M51 25 L48 12 M57 25 L59.5 12.5"
        {...ink}
        stroke={LINE}
        fill="none"
        strokeWidth={2.2}
      />
      <Eye cx={48} cy={11.5} r={2.8} />
      <Eye cx={59.5} cy={12} r={2.8} />
      <path d={FOOT} fill={PALE} {...ink} />
      <ellipse cx={50.5} cy={34.5} rx={2} ry={1.3} fill={BLUSH} />
      <Smile cx={54.5} cy={35} w={4} />
      <circle cx={SHELL.cx} cy={SHELL.cy} r={SHELL.r} fill={ACCENT_SOFT} {...ink} />
      <circle cx={SHELL.cx} cy={SHELL.cy} r={6} fill={ACCENT} />
      <path d={SPIRAL} {...fine} strokeWidth={1.8} />
      {idle ? (
        <path
          d="M14 54 Q16 52 18 54 M34 54 Q36 52 38 54"
          {...fine}
          stroke={MID}
          strokeWidth={1.6}
        />
      ) : (
        <AtLaptop pose={pose} pawFill={PALE} />
      )}
    </g>
  );
}

export const snail: CreatureDefinition = {
  id: "snail",
  name: "Snail",
  description: "An unhurried snail with a swirled accent shell and eyes on tall stalks.",
  render,
};
