import {
  counterIds,
  emptyLayout,
  type LayoutAction,
  type LayoutEnv,
  type LayoutState,
  reduceLayout,
} from "../../src/shell/layout/index.ts";

/** Deterministic env: ids 1, 2, …; timestamps one second apart. */
export function testEnv(width = 1600, contentWidth?: number): LayoutEnv {
  let t = 0;
  const env: LayoutEnv = {
    width,
    now: () => new Date(Date.UTC(2026, 9, 19, 9, 0, t++)).toISOString(),
    newId: counterIds(),
  };
  if (contentWidth !== undefined) env.contentWidth = contentWidth;
  return env;
}

export function run(
  actions: LayoutAction[],
  env: LayoutEnv = testEnv(),
  start: LayoutState = emptyLayout("t1"),
): LayoutState {
  return actions.reduce((s, a) => reduceLayout(s, a, env), start);
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
