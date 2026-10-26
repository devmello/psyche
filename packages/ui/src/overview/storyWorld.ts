import {
  type FixtureWorld,
  type InsightsFixtureState,
  insightsFixtures,
} from "../fixtures/index.ts";

/**
 * A `StoryWorld` `edit` that serves `insights.summary` from the fixtures of `state` (a new user,
 * a typical month, a heavy year); `null` leaves the Gateway answering a new install's zeros.
 */
export const insightsWorld =
  (state: InsightsFixtureState | null) =>
  (world: FixtureWorld): void => {
    if (state !== null) Object.assign(world, { insights: insightsFixtures(state) });
  };
