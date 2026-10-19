import type { ReactElement } from "react";

export type CreatureId =
  | "moth"
  | "owl"
  | "fox"
  | "axolotl"
  | "hedgehog"
  | "octopus"
  | "cat"
  | "frog"
  | "snail"
  | "bat"
  | "turtle"
  | "sprout";

/** `idle` is the creature alone; the two typing frames alternate at 1.5 Hz while working. */
export type CreaturePose = "idle" | "typing-a" | "typing-b";

export type TypingPose = Exclude<CreaturePose, "idle">;

export interface CreatureDefinition {
  id: CreatureId;
  name: string;
  /** One sentence for alt text and the onboarding picker. */
  description: string;
  /** SVG children for a `viewBox="0 0 64 64"` canvas (a `<g>`), never the `<svg>` element. */
  render: (pose: CreaturePose) => ReactElement;
}
