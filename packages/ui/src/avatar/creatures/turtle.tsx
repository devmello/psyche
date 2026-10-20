import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import {
  ACCENT,
  ACCENT_SOFT,
  Cheeks,
  DEEP,
  Eyes,
  fine,
  ink,
  Mirrored,
  PALE,
  Smile,
} from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      <g transform={idle ? undefined : "translate(0 -6)"}>
        {idle && (
          <Mirrored>
            <path
              d="M13.5 44 H23 V53 C23 55 21.5 56 19.5 56 H17 C15 56 13.5 55 13.5 53 Z"
              fill={PALE}
              {...ink}
            />
            <path d="M16.5 56 V54 M19.8 56 V54" {...fine} strokeWidth={1.2} />
          </Mirrored>
        )}
        {/* domed shell with a central plate and seams */}
        <path d="M8 44 C8 24 18 12 32 12 C46 12 56 24 56 44 Z" fill={ACCENT_SOFT} {...ink} />
        <path
          d="M28 16.5 H36 L39.5 23 L36 29.5 H28 L24.5 23 Z"
          fill={ACCENT}
          {...ink}
          strokeWidth={1.6}
        />
        <path
          d="M24.5 23 H11.5 M39.5 23 H52.5 M28 16.5 L24 13.5 M36 16.5 L40 13.5 M28 29.5 L24 33 M36 29.5 L40 33"
          {...fine}
          strokeWidth={1.6}
        />
        <rect x={6} y={40.5} width={52} height={6} rx={3} fill={DEEP} {...ink} />
        <circle cx={32} cy={40} r={10} fill={PALE} {...ink} />
        <Eyes dx={4.2} cy={39} r={2.2} />
        <Cheeks dx={7.5} cy={43} rx={1.9} />
        <Smile cy={43.5} w={4} />
      </g>
      {!idle && <AtLaptop pose={pose} pawFill={PALE} />}
    </g>
  );
}

export const turtle: CreatureDefinition = {
  id: "turtle",
  get name() {
    return t("agent.creature.turtle.name");
  },
  get description() {
    return t("agent.creature.turtle.description");
  },
  render,
};
