import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import { ACCENT_SOFT, Cheeks, Eye, ink, LINE, MID, Mirrored, PALE } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

/**
 * Head and eye bumps drawn as one silhouette: a wide outline pass under a fill pass, so the outline
 * only shows around the outside of the union.
 */
function Head(): ReactElement {
  const shapes = (
    <g>
      <circle cx={21} cy={19.5} r={7.5} />
      <circle cx={43} cy={19.5} r={7.5} />
      <ellipse cx={32} cy={30} rx={20.5} ry={12.5} />
    </g>
  );
  return (
    <g>
      <g fill={LINE} stroke={LINE} strokeWidth={4} strokeLinejoin="round">
        {shapes}
      </g>
      <g fill={MID}>{shapes}</g>
    </g>
  );
}

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      {idle && (
        <Mirrored>
          <path
            d="M15 57 C15 53 19 51 23 52 L27 56.5 C27 58.5 25 59 23 58.5 L21 57.5 L18.5 58.5 Z"
            fill={MID}
            {...ink}
          />
        </Mirrored>
      )}
      <ellipse cx={32} cy={46} rx={16} ry={11} fill={MID} {...ink} />
      <ellipse cx={32} cy={49} rx={9} ry={7} fill={PALE} />
      <g fill={ACCENT_SOFT}>
        <circle cx={20} cy={46} r={2} />
        <circle cx={44.5} cy={44} r={1.6} />
      </g>
      <Head />
      <Mirrored>
        <circle cx={21} cy={19} r={4.6} fill={PALE} />
      </Mirrored>
      <Eye cx={21} cy={19} r={3} />
      <Eye cx={43} cy={19} r={3} />
      <g fill={ACCENT_SOFT}>
        <circle cx={29} cy={24} r={1.5} />
        <circle cx={35} cy={22.5} r={1} />
      </g>
      <Cheeks dx={14.5} cy={32} rx={2.6} />
      <path d="M21 32 Q32 40.5 43 32" {...ink} fill="none" />
      {!idle && <AtLaptop pose={pose} pawFill={MID} />}
    </g>
  );
}

export const frog: CreatureDefinition = {
  id: "frog",
  get name() {
    return t("agent.creature.frog.name");
  },
  get description() {
    return t("agent.creature.frog.description");
  },
  render,
};
