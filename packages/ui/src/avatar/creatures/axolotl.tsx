import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import { ACCENT, ACCENT_SOFT, Cheeks, Eyes, ink, Mirrored, PALE, Smile } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      {idle && (
        <g>
          <path d="M40 50 C50 55 57 50 59 41 C54 46 48 46 42 44 Z" fill={PALE} {...ink} />
          <Mirrored>
            <ellipse cx={25} cy={56.5} rx={3.4} ry={2.4} fill={PALE} {...ink} />
          </Mirrored>
        </g>
      )}
      <ellipse cx={32} cy={47} rx={11} ry={9.5} fill={PALE} {...ink} />
      <Mirrored>
        {/* three frilly external gills */}
        <ellipse
          cx={10}
          cy={15}
          rx={6.5}
          ry={2.8}
          transform="rotate(38 10 15)"
          fill={ACCENT_SOFT}
          {...ink}
        />
        <ellipse cx={7} cy={24} rx={6.5} ry={2.8} fill={ACCENT} {...ink} />
        <ellipse
          cx={10}
          cy={33}
          rx={6.5}
          ry={2.8}
          transform="rotate(-38 10 33)"
          fill={ACCENT_SOFT}
          {...ink}
        />
      </Mirrored>
      <ellipse cx={32} cy={26} rx={18.5} ry={14} fill={PALE} {...ink} />
      <Eyes dx={10.5} cy={24} r={2.5} />
      <Cheeks dx={13} cy={30} rx={2.4} />
      <Smile cy={29.5} w={12} />
      {!idle && <AtLaptop pose={pose} pawFill={PALE} />}
    </g>
  );
}

export const axolotl: CreatureDefinition = {
  id: "axolotl",
  get name() {
    return t("agent.creature.axolotl.name");
  },
  get description() {
    return t("agent.creature.axolotl.description");
  },
  render,
};
