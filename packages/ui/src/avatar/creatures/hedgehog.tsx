import type { ReactElement } from "react";
import { AtLaptop } from "./laptop.tsx";
import { Cheeks, DEEP, Eyes, ink, LINE, MID, Mirrored, n, PALE } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

/** A star-shaped spine coat: `count` points between an inner and outer ellipse. */
function spines(cx: number, cy: number, inner: number, outer: number, count: number): string {
  const points: string[] = [];
  for (let i = 0; i < count; i++) {
    const tip = (i / count) * Math.PI * 2 - Math.PI / 2;
    const notch = tip + Math.PI / count;
    points.push(`${n(cx + outer * Math.cos(tip))} ${n(cy + outer * 0.92 * Math.sin(tip))}`);
    points.push(`${n(cx + inner * Math.cos(notch))} ${n(cy + inner * 0.92 * Math.sin(notch))}`);
  }
  return `M${points.join(" L")} Z`;
}

const COAT = spines(32, 33, 19.5, 25.5, 22);

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g transform={idle ? undefined : "translate(0 -3)"}>
      <path d={COAT} fill={DEEP} {...ink} />
      <Mirrored>
        <circle cx={20.5} cy={26.5} r={3.6} fill={MID} {...ink} />
        {idle && <ellipse cx={25} cy={57} rx={3.6} ry={2.4} fill={MID} {...ink} />}
      </Mirrored>
      <ellipse cx={32} cy={37} rx={14} ry={11.5} fill={PALE} {...ink} />
      <ellipse cx={32} cy={41} rx={5.5} ry={4} fill={MID} />
      <Eyes dx={6} cy={35} r={2.3} />
      <Cheeks dx={9.5} cy={40} rx={2.2} />
      <ellipse cx={32} cy={39.6} rx={2.2} ry={1.7} fill={LINE} />
      <path d="M30 42.6 Q32 44 34 42.6" {...ink} strokeWidth={1.4} fill="none" />
      {!idle && (
        <g transform="translate(0 3)">
          <AtLaptop pose={pose} pawFill={MID} />
        </g>
      )}
    </g>
  );
}

export const hedgehog: CreatureDefinition = {
  id: "hedgehog",
  name: "Hedgehog",
  description: "A round hedgehog with a spiky coat, a soft pale face and a button nose.",
  render,
};
