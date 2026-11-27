import type { SearchSourceId } from "@psyche/protocol";

/**
 * Onboarding's "Make these searchable" (on by default): the search sources that match the
 * accounts and apps the owner connected, switched on through the existing source setting
 * (`search.sources.configure`, the one Settings → Search sources uses). Only what was connected
 * is turned on: Messages when Messages was connected, never as a side effect of Mail.
 */
const SOURCES_OF: Readonly<Record<string, readonly SearchSourceId[]>> = {
  "apple:mail": ["mail"],
  "apple:calendar": ["calendar"],
  "apple:reminders": ["reminders"],
  "apple:notes": ["notes"],
  "apple:messages": ["messages"],
  "apple:contacts": ["contacts"],
  google: ["mail", "calendar"],
  microsoft: ["mail", "calendar"],
  imap: ["mail"],
};

/** The sources a set of connected connector types makes searchable, in a stable order. */
export function searchSourcesFor(types: readonly string[]): SearchSourceId[] {
  const out = new Set<SearchSourceId>();
  for (const type of types) for (const source of SOURCES_OF[type] ?? []) out.add(source);
  return [...out];
}

type Call = (
  method: string,
  params: unknown,
  options?: { idempotencyKey?: string },
) => Promise<unknown>;

/**
 * Switches on the sources for the connected accounts. Best effort, one source at a time: a source
 * that cannot be switched on yet (a missing macOS permission) stays off and says why in Settings;
 * it never blocks finishing setup.
 */
export async function enableSearchSources(
  call: Call,
  types: readonly string[],
  now: () => Date = () => new Date(),
): Promise<SearchSourceId[]> {
  const enabled: SearchSourceId[] = [];
  for (const source of searchSourcesFor(types)) {
    try {
      await call(
        "search.sources.configure",
        { source, enabled: true },
        { idempotencyKey: `onboarding:search:${source}:${now().getTime()}` },
      );
      enabled.push(source);
    } catch {
      // See above.
    }
  }
  return enabled;
}
