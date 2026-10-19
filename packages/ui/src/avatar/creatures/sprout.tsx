import type { ReactElement } from "react";
import { AtLaptop, type PawRenderer } from "./laptop.tsx";
import {
  ACCENT,
  ACCENT_SOFT,
  Cheeks,
  Eyes,
  fine,
  ink,
  MID,
  Mirrored,
  PALE,
  Smile,
} from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

/** Leaf-shaped hands. */
const leafPaw: PawRenderer = (x, y, side) => (
  <ellipse
    cx={x}
    cy={y}
    rx={3.4}
    ry={4.4}
    transform={`rotate(${side === "left" ? -25 : 25} ${x} ${y})`}
    fill={ACCENT_SOFT}
    {...ink}
  />
);

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      <g transform={idle ? undefined : "translate(0 -3)"}>
        {/* stem and two leaves */}
        <path d="M32 25 C32 20 31 16.5 32 12.5" {...fine} strokeWidth={2} />
        <path
          d="M32 14 C26 5.5 16 5.5 11.5 9.5 C15.5 17.5 26 18.5 32 14 Z"
          fill={ACCENT}
          {...ink}
        />
        <path d="M30 13.5 Q22 10.5 15 10" {...fine} stroke={ACCENT_SOFT} strokeWidth={1.3} />
        <path
          d="M32 12.5 C36 5 44 3 50.5 6 C47.5 13.5 39 15.5 32 12.5 Z"
          fill={ACCENT_SOFT}
          {...ink}
        />
        <path d="M34 11.5 Q41 8.5 47.5 7" {...fine} stroke={ACCENT} strokeWidth={1.3} />
        {idle && (
          <Mirrored>
            <ellipse cx={26} cy={53.5} rx={3.4} ry={2.6} fill={MID} {...ink} />
          </Mirrored>
        )}
        {/* round seed body */}
        <ellipse cx={32} cy={38} rx={15.5} ry={14} fill={PALE} {...ink} />
        <path d="M21 30 Q24 26.5 28 25.5" {...fine} stroke={MID} strokeWidth={2} />
        <Eyes dx={6} cy={37} r={2.5} />
        <Cheeks dx={10.5} cy={41.5} rx={2.3} />
        <Smile cy={41.5} w={5} />
      </g>
      {!idle && <AtLaptop pose={pose} pawFill={ACCENT_SOFT} renderPaw={leafPaw} />}
    </g>
  );
}

export const sprout: CreatureDefinition = {
  id: "sprout",
  name: "Sprout",
  description: "A little seed creature with a round pale body and two fresh leaves on top.",
  render,
};
