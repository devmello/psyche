import type { AnswerSource } from "@psyche/protocol";

/**
 * Citations for what an agent run makes (widgets and canvas artifacts). `search_everything` emits
 * its chips into the chat; the same items are recorded here by run id, so a widget or a document
 * the run makes later carries the sources it drew on. The model never supplies them: a source it
 * writes itself is dropped and only the recorded items are attached.
 *
 * In memory and bounded: the last runs only, so a restart forgets them (the artifact keeps the
 * sources it was made with). Items are the same ones the chat chips show, already filtered by the
 * agent's audience. A route is kept only when it is an in-app path, never a URL.
 */

export const RUN_SOURCES_LIMIT = 20;
const MAX_RUNS = 200;

const runs = new Map<string, AnswerSource[]>();

/** An in-app path (`/library/...`), or null. Never `javascript:`, a URL or a protocol-relative path. */
export function inAppRoute(route: string | null | undefined): string | null {
  if (typeof route !== "string") return null;
  return route.startsWith("/") &&
    !route.startsWith("//") &&
    !/\s/.test(route) &&
    ![...route].some((c) => c.charCodeAt(0) < 0x20)
    ? route
    : null;
}

/** Records the sources a search emitted in a run. Repeated ids are kept once; the cap holds. */
export function recordRunSources(runId: string | undefined, items: readonly AnswerSource[]): void {
  if (runId === undefined || items.length === 0) return;
  const have = runs.get(runId) ?? [];
  for (const item of items) {
    if (have.length >= RUN_SOURCES_LIMIT) break;
    if (have.some((h) => h.id === item.id)) continue;
    have.push({ ...item, route: inAppRoute(item.route) });
  }
  // Re-insert so the most recent run is last, then drop the oldest beyond the cap.
  runs.delete(runId);
  runs.set(runId, have);
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
}

/** The sources recorded for a run, in the order they were found. Empty when there are none. */
export function runSources(runId: string | undefined): AnswerSource[] {
  if (runId === undefined) return [];
  return (runs.get(runId) ?? []).map((s) => ({ ...s }));
}

/** A spec with the run's sources attached (or none), whatever sources the model wrote itself. */
export function withRunSources<T extends { sources?: unknown }>(
  spec: T,
  runId: string | undefined,
): T {
  const { sources: _model, ...rest } = spec;
  const items = runSources(runId);
  return (items.length > 0 ? { ...rest, sources: items } : rest) as T;
}

/** Test hook: forget every run. */
export function resetRunSourcesForTests(): void {
  runs.clear();
}
