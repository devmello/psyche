/**
 * Performance budgets from the spec (P1, P3, P9) hold on a developer Mac. Shared CI runners are
 * cold and run test files in parallel, so they get a slack factor; the local run is the gate.
 */
export const budgetMs = (ms: number): number => (process.env.CI ? ms * 3 : ms);
