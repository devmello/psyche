import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import { BLUSH, Cheeks, DEEP, Eyes, fine, GLINT, ink, MID, Mirrored, Smile } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      <Mirrored>
        {/* scalloped wing with two finger bones */}
        <path
          d="M24 25 C18 19 10 15.5 3.5 17.5 C5.5 23 5.5 29 3.5 35 C7.5 33 11.5 34 12.5 38.5 C15.5 35.5 19.5 36.5 21.5 41.5 Z"
          fill={DEEP}
          {...ink}
        />
        <path d="M21 27 L6 20 M21 30 L11 37" {...fine} strokeWidth={1.2} />
        <path d="M21.5 22 L19 5.5 L29.5 16 Z" fill={DEEP} {...ink} />
        <path d="M22.5 18.5 L21 9.5 L26.5 15.5 Z" fill={BLUSH} />
        {idle && <ellipse cx={29} cy={56} rx={2.4} ry={2} fill={DEEP} {...ink} />}
      </Mirrored>
      <ellipse cx={32} cy={45} rx={9} ry={10} fill={DEEP} {...ink} />
      <ellipse cx={32} cy={47} rx={5} ry={6} fill={MID} />
      <circle cx={32} cy={29} r={13} fill={DEEP} {...ink} />
      <ellipse cx={32} cy={31} rx={9.5} ry={8} fill={MID} />
      <Eyes dx={4.5} cy={29} r={2.4} />
      <Cheeks dx={8} cy={33.5} rx={1.8} />
      <Smile cy={34} w={6} />
      <Mirrored>
        <path d="M29.7 35.4 L30.4 37.6 L31.2 35.6 Z" fill={GLINT} {...ink} strokeWidth={0.8} />
      </Mirrored>
      {!idle && <AtLaptop pose={pose} pawFill={DEEP} />}
    </g>
  );
}

export const bat: CreatureDefinition = {
  id: "bat",
  get name() {
    return t("agent.creature.bat.name");
  },
  get description() {
    return t("agent.creature.bat.description");
  },
  render,
};
