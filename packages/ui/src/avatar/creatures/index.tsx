/**
 * The 12 bundled avatar creatures (docs/06-ui-design.md §4.7). Each renders the children of a
 * `viewBox="0 0 64 64"` SVG in three poses: `idle`, and `typing-a` / `typing-b`, the two frames of
 * the working loop (§4.5). Colors are theme variables, so the creatures follow the accent seed and
 * the light / dark appearance.
 */
import { axolotl } from "./axolotl.tsx";
import { bat } from "./bat.tsx";
import { cat } from "./cat.tsx";
import { fox } from "./fox.tsx";
import { frog } from "./frog.tsx";
import { hedgehog } from "./hedgehog.tsx";
import { moth } from "./moth.tsx";
import { octopus } from "./octopus.tsx";
import { owl } from "./owl.tsx";
import { snail } from "./snail.tsx";
import { sprout } from "./sprout.tsx";
import { turtle } from "./turtle.tsx";
import type { CreatureDefinition, CreatureId } from "./types.ts";

export type { CreatureDefinition, CreatureId, CreaturePose, TypingPose } from "./types.ts";

/** The bundled set in picker order; the default moth comes first. */
export const CREATURES: readonly CreatureDefinition[] = [
  moth,
  owl,
  fox,
  axolotl,
  hedgehog,
  octopus,
  cat,
  frog,
  snail,
  bat,
  turtle,
  sprout,
];

export const DEFAULT_CREATURE: CreatureId = "moth";

const BY_ID = new Map<string, CreatureDefinition>(CREATURES.map((c) => [c.id, c]));

/** Looks a creature up by id, falling back to the default moth for unknown ids. */
export function getCreature(id: string): CreatureDefinition {
  return BY_ID.get(id) ?? moth;
}
