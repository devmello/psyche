import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import {
  ACCENT,
  ACCENT_SOFT,
  BLUSH,
  Cheeks,
  DEEP,
  Eyes,
  fine,
  ink,
  MID,
  Mirrored,
  PALE,
  Tube,
} from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      {idle && (
        <Tube d="M41 53 C53 55 58 47 55 38 C54 35 51.5 34.5 50.5 36" fill={MID} width={4.5} />
      )}
      <ellipse cx={32} cy={48} rx={13} ry={10} fill={MID} {...ink} />
      <ellipse cx={32} cy={50.5} rx={6} ry={6} fill={PALE} />
      <Mirrored>
        {/* short rounded ear with a pink lining */}
        <path d="M15 22 L16 7.5 L27.5 13.5 Z" fill={MID} {...ink} />
        <path d="M17.5 18 L18 11.5 L23.5 14.5 Z" fill={BLUSH} />
        {idle && <ellipse cx={27} cy={57.5} rx={3.4} ry={2.4} fill={PALE} {...ink} />}
      </Mirrored>
      <ellipse cx={32} cy={26} rx={18} ry={15} fill={MID} {...ink} />
      <path
        d="M32 12.5 V16.5 M27.5 13.5 L28.5 16.5 M36.5 13.5 L35.5 16.5"
        {...fine}
        stroke={DEEP}
        strokeWidth={2}
      />
      <Mirrored>
        <path d="M21 30.5 L11 29 M21 33 L11.5 34.5" {...fine} strokeWidth={1.2} />
      </Mirrored>
      <Eyes dx={7} cy={25.5} r={2.6} />
      <Cheeks dx={10} cy={31} rx={2} />
      <path d="M30.6 30.6 H33.4 L32 32.4 Z" fill={ACCENT_SOFT} {...ink} strokeWidth={1.2} />
      <path d="M29 34 Q30.5 35.6 32 34 Q33.5 35.6 35 34" {...fine} />
      {/* collar and bell */}
      <path
        d="M21.5 38.6 Q32 44.5 42.5 38.6"
        fill="none"
        stroke={ACCENT}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
      <circle cx={32} cy={42.6} r={2} fill={ACCENT_SOFT} {...ink} strokeWidth={1.2} />
      {!idle && <AtLaptop pose={pose} pawFill={PALE} />}
    </g>
  );
}

export const cat: CreatureDefinition = {
  id: "cat",
  get name() {
    return t("agent.creature.cat.name");
  },
  get description() {
    return t("agent.creature.cat.description");
  },
  render,
};
