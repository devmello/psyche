import type { ReactElement } from "react";
import { AtLaptop } from "./laptop.tsx";
import { Cheeks, DEEP, Eyes, ink, LINE, MID, Mirrored, PALE } from "./parts.tsx";
import type { CreatureDefinition, CreaturePose } from "./types.ts";

const HEAD =
  "M15 23 C15 14 22 11 32 11 C42 11 49 14 49 23 C49 27 51 30 55 32 C49 34 44 39.5 32 41 C20 39.5 15 34 9 32 C13 30 15 27 15 23 Z";
const MASK =
  "M9 32 C15 34 20 39.5 32 41 C44 39.5 49 34 55 32 C49 29.5 41 29 37 31.5 C35 33 29 33 27 31.5 C23 29 15 29.5 9 32 Z";

function render(pose: CreaturePose): ReactElement {
  const idle = pose === "idle";
  return (
    <g>
      {idle && (
        <g>
          {/* bushy tail curling up the right side, pale tip */}
          <path
            d="M40 54.5 C50 58.5 60 52.5 58 40 C57 34 53 30 50 30 C51 36 50 44 41 47 Z"
            fill={MID}
            {...ink}
          />
          <path
            d="M50 30 C53 30 57 34 58 40 L55.5 38.2 L53.4 39.4 L52.2 36.4 L50.8 36 C51 34 50.8 32 50 30 Z"
            fill={PALE}
            {...ink}
          />
        </g>
      )}
      <ellipse cx={32} cy={47.5} rx={12} ry={10.5} fill={MID} {...ink} />
      <ellipse cx={32} cy={49.5} rx={6} ry={7} fill={PALE} />
      {idle && (
        <Mirrored>
          <ellipse cx={27} cy={57.5} rx={3.4} ry={2.4} fill={DEEP} {...ink} />
        </Mirrored>
      )}
      <Mirrored>
        {/* tall pointed ear with a dark lining */}
        <path d="M16 23 L14 4.5 L29 13.5 Z" fill={MID} {...ink} />
        <path d="M17.5 19 L16.5 9 L24.5 14 Z" fill={DEEP} />
      </Mirrored>
      <path d={HEAD} fill={MID} />
      <path d={MASK} fill={PALE} />
      <path d={HEAD} fill="none" {...ink} />
      <Eyes dx={7} cy={24} r={2.4} />
      <Cheeks dx={11} cy={30} rx={2.2} />
      <ellipse cx={32} cy={34.5} rx={2.6} ry={1.9} fill={LINE} />
      <path d="M30 37.5 Q32 39 34 37.5" {...ink} strokeWidth={1.4} fill="none" />
      {!idle && <AtLaptop pose={pose} pawFill={DEEP} />}
    </g>
  );
}

export const fox: CreatureDefinition = {
  id: "fox",
  name: "Fox",
  description: "A sitting fox with tall pointed ears, a pale muzzle and a bushy tail.",
  render,
};
