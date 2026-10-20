import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import { ACCENT, ACCENT_SOFT, DEEP, GLINT, ink, LINE, MID, Mirrored, PALE } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      <Mirrored>
        {/* ear tuft */}
        <path d="M16 19 L8.5 7.5 L25 13 Z" fill={DEEP} {...ink} />
        {idle && <ellipse cx={27} cy={57.5} rx={3.2} ry={2} fill={ACCENT_SOFT} {...ink} />}
      </Mirrored>
      <ellipse cx={32} cy={34} rx={20} ry={22} fill={MID} {...ink} />
      <ellipse cx={32} cy={45} rx={11} ry={9.5} fill={PALE} />
      <path
        d="M26 41 L28 43 L30 41 M34 41 L36 43 L38 41 M30 47 L32 49 L34 47"
        {...ink}
        stroke={DEEP}
        strokeWidth={1.6}
        fill="none"
      />
      <Mirrored>
        {/* facial disc and a big round eye */}
        <circle cx={24.5} cy={28} r={8.5} fill={PALE} />
        <circle cx={24.5} cy={28} r={5.2} fill={ACCENT} {...ink} />
        <circle cx={24.8} cy={28.3} r={2.7} fill={LINE} />
        <circle cx={23.6} cy={27.1} r={1} fill={GLINT} />
        {idle && <path d="M13.5 31 Q7.5 43 18 52 Q17.5 41 13.5 31 Z" fill={DEEP} {...ink} />}
      </Mirrored>
      <path d="M29.5 34 H34.5 L32 38.5 Z" fill={ACCENT_SOFT} {...ink} strokeWidth={1.6} />
      {!idle && <AtLaptop pose={pose} pawFill={DEEP} />}
    </g>
  );
}

export const owl: CreatureDefinition = {
  id: "owl",
  get name() {
    return t("agent.creature.owl.name");
  },
  get description() {
    return t("agent.creature.owl.description");
  },
  render,
};
