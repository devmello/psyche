/**
 * The tiny laptop every creature types on while working. The lid faces the viewer and sits in
 * front of the creature; the paws are drawn behind it, so in each frame one paw peeks over the
 * lid while the other is down on the keys. Swapping `typing-a` and `typing-b` reads as typing.
 */
import type { ReactElement } from "react";
import { ACCENT_SOFT, ink } from "./parts.tsx";
import type { TypingPose } from "./types.ts";

/** The y coordinate of the lid's top edge: anything the creature needs seen sits above it. */
export const LAPTOP_TOP = 43;

export type PawSide = "left" | "right";

export type PawRenderer = (x: number, y: number, side: PawSide) => ReactElement;

const PAW_UP = 39.6;
const PAW_DOWN = 45.4;

export function pawY(pose: TypingPose, side: PawSide): number {
  const leftUp = pose === "typing-a";
  return (side === "left") === leftUp ? PAW_UP : PAW_DOWN;
}

export function Laptop(): ReactElement {
  return (
    <g>
      <path d="M19.5 56 L21.5 43 H42.5 L44.5 56 Z" fill="var(--accent-3)" {...ink} />
      <circle cx={32} cy={49.5} r={1.7} fill={ACCENT_SOFT} />
      <rect x={11} y={55} width={42} height={4.5} rx={2.25} fill="var(--gray-8)" {...ink} />
    </g>
  );
}

export interface AtLaptopProps {
  pose: TypingPose;
  /** Fill for the default round paws. */
  pawFill: string;
  /** Draws a custom paw centered on (x, y) instead of the default round one. */
  renderPaw?: PawRenderer;
}

/** The paws (behind) and the laptop (in front); render it after the creature's body. */
export function AtLaptop({ pose, pawFill, renderPaw }: AtLaptopProps): ReactElement {
  const paw: PawRenderer =
    renderPaw ?? ((x, y) => <ellipse cx={x} cy={y} rx={3.8} ry={3.3} fill={pawFill} {...ink} />);
  return (
    <g>
      {paw(23, pawY(pose, "left"), "left")}
      {paw(41, pawY(pose, "right"), "right")}
      <Laptop />
    </g>
  );
}
