import type { ReactElement } from "react";
import { AtLaptop } from "./laptop.tsx";
import {
  ACCENT,
  ACCENT_SOFT,
  Cheeks,
  GLINT,
  ink,
  LINE,
  MID,
  Mirrored,
  PALE,
  Smile,
} from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

function LanternEye({ cx }: { cx: number }): ReactElement {
  return (
    <g>
      <circle cx={cx} cy={26} r={4.4} fill={ACCENT_SOFT} {...ink} />
      <circle cx={cx} cy={26.4} r={2.3} fill={LINE} />
      <circle cx={cx - 0.9} cy={25.4} r={0.9} fill={GLINT} />
    </g>
  );
}

function render(pose: CreaturePose): ReactElement {
  return (
    <g>
      <Mirrored>
        {/* feathery antenna */}
        <path d="M28 16 C25 11 21 7 18 4 C23 5 28 9 29.5 15 Z" fill={MID} {...ink} />
        {/* hind wing, then fore wing with its eye spot */}
        <ellipse
          cx={19}
          cy={43}
          rx={8.5}
          ry={6.5}
          transform="rotate(32 19 43)"
          fill={MID}
          {...ink}
        />
        <circle cx={17} cy={44.5} r={2} fill={ACCENT} />
        <ellipse
          cx={15.5}
          cy={27}
          rx={12.5}
          ry={10}
          transform="rotate(-28 15.5 27)"
          fill={PALE}
          {...ink}
        />
        <circle cx={13.5} cy={26} r={4.4} fill={ACCENT_SOFT} />
        <circle cx={13.5} cy={26} r={2.1} fill={ACCENT} />
      </Mirrored>
      {pose === "idle" && (
        <Mirrored>
          <ellipse cx={28} cy={55.5} rx={2.6} ry={2.2} fill={MID} {...ink} />
        </Mirrored>
      )}
      <ellipse cx={32} cy={44} rx={8.5} ry={10.5} fill={MID} {...ink} />
      <path
        d="M26.5 46 Q29 48 31.5 46 M32.5 50 Q35 52 37.5 50"
        {...ink}
        stroke="var(--gray-7)"
        fill="none"
      />
      {/* fluffy head */}
      <circle cx={32} cy={27} r={12.5} fill={PALE} {...ink} />
      <path
        d="M24 17.5 Q27 15.5 29 17 Q32 14.5 35 17 Q37 15.5 40 17.5"
        {...ink}
        fill="none"
        strokeWidth={1.4}
      />
      <LanternEye cx={26.6} />
      <LanternEye cx={37.4} />
      <Cheeks dx={9.5} cy={33} rx={2.3} />
      <Smile cy={33} w={4} />
      {pose !== "idle" && <AtLaptop pose={pose} pawFill={MID} />}
    </g>
  );
}

export const moth: CreatureDefinition = {
  id: "moth",
  name: "Moth",
  description:
    "A pale, fluffy moth with glowing lantern eyes and accent-colored spots on its wings.",
  render,
};
