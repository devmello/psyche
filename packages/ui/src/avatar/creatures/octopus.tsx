import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { AtLaptop } from "./laptop.tsx";
import { ACCENT_SOFT, Cheeks, Eyes, ink, MID, Mirrored, Smile, Tube } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

const HEAD = "M12 33 C12 17 21 8 32 8 C43 8 52 17 52 33 C52 40 45 43 32 43 C19 43 12 40 12 33 Z";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      {idle && (
        <Mirrored>
          <Tube d="M17 38 C12 44 8 47 7 51 C6 54.5 9.5 56 11 53.5" fill={MID} width={5} />
          <Tube d="M23 41 C21 47 19 51 21 55 C22 57.5 25.5 57 25.5 54.5" fill={MID} width={5} />
          <Tube
            d="M28.5 42.5 C28.5 48 27 51.5 28 55.5 C28.5 57.5 31 57.5 31 55.5"
            fill={MID}
            width={4.5}
          />
        </Mirrored>
      )}
      <path d={HEAD} fill={MID} {...ink} />
      <g fill={ACCENT_SOFT}>
        <circle cx={22} cy={17} r={2.4} />
        <circle cx={17.5} cy={24.5} r={1.5} />
        <circle cx={40} cy={13.5} r={1.7} />
        <circle cx={45} cy={21} r={2.6} />
        <circle cx={33} cy={14.5} r={1.2} />
      </g>
      <Eyes dx={7} cy={30} r={2.8} />
      <Cheeks dx={12} cy={35} rx={2.4} />
      <Smile cy={35} w={5} />
      {!idle && <AtLaptop pose={pose} pawFill={MID} />}
    </g>
  );
}

export const octopus: CreatureDefinition = {
  id: "octopus",
  get name() {
    return t("agent.creature.octopus.name");
  },
  get description() {
    return t("agent.creature.octopus.description");
  },
  render,
};
