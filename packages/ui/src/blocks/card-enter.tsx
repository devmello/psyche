import { type ReactNode, useEffect, useState } from "react";
import { FadeIn } from "../motion/index.ts";

/** A card that arrives this long after it was created is history, not news: it doesn't animate. */
const LIVE_MS = 60_000;
let cardsSettled = false;

/**
 * True when a transcript card mounts after the first wave of cards has rendered, and (given a
 * creation time) while it is still live, so history and story renders stay still and only cards
 * that arrive later enter with the list enter (docs/design/motion.md §4.1).
 */
export function useEntersLater(createdAt?: string | null): boolean {
  const [later] = useState(
    () =>
      cardsSettled &&
      (createdAt === undefined ||
        createdAt === null ||
        Date.now() - Date.parse(createdAt) < LIVE_MS),
  );
  useEffect(() => {
    cardsSettled = true;
  }, []);
  return later;
}

/**
 * The list enter for a card (fade + 8 px rise on `spring.snappy`). `MotionConfig` drops the rise
 * under reduced motion and keeps the fade. Streamed text inside never animates on its own.
 */
export function CardEnter({
  animate,
  children,
}: {
  animate: boolean;
  children: ReactNode;
}): ReactNode {
  return animate ? <FadeIn>{children}</FadeIn> : children;
}
