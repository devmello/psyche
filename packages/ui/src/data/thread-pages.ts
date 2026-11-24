import type { ThreadListEntry } from "@psyche/protocol";
import type { Dict, UiState } from "./state.ts";
import type { GatewayStore } from "./store.ts";

/**
 * `threads.list` paging for the sidebar (one cursor per `includeArchived` flag). The Gateway pages
 * the list most recent first; the first page is the head and every further page is appended.
 */

export interface ThreadPageState {
  /** Cursor for the next page; `null` when the list is complete. */
  cursor: string | null;
  /** True once a page beyond the head has loaded, so a head reload keeps its cursor. */
  beyondHead: boolean;
  /** A further page is in flight. */
  loading: boolean;
}

export interface ThreadPageResult {
  threads: ThreadListEntry[];
  nextCursor?: string | null;
}

/** The store-side slice this module needs; `GatewayStore` satisfies it. */
export type ThreadPageStore = Pick<GatewayStore, "getState" | "update" | "version" | "call">;

export const threadPageKey = (includeArchived: boolean): string => String(includeArchived);

/**
 * Listed threads merged by id. A thread an event touched after the request started is newer than
 * this page, so it keeps its state. Threads not listed are kept: a reload never drops a page.
 */
export function mergeListedThreads(
  s: UiState,
  listed: readonly ThreadListEntry[],
  version: number,
): Dict<ThreadListEntry> {
  const next: Dict<ThreadListEntry> = { ...s.threads };
  for (const t of listed) {
    if ((s.touched[`threads:${t.thread.id}`] ?? -1) > version) continue;
    next[t.thread.id] = t;
  }
  return next;
}

/**
 * Applies the first page. A reload keeps the cursor of pages already loaded beyond the head;
 * otherwise the cursor is the head's own `nextCursor`.
 */
export function applyHeadPage(
  s: UiState,
  key: string,
  res: ThreadPageResult,
  version: number,
): UiState {
  const prev = s.threadPages[key];
  const beyondHead = prev?.beyondHead ?? false;
  return {
    ...s,
    threads: mergeListedThreads(s, res.threads, version),
    threadsLoaded: true,
    threadPages: {
      ...s.threadPages,
      [key]: {
        cursor: beyondHead ? (prev?.cursor ?? null) : (res.nextCursor ?? null),
        beyondHead,
        loading: prev?.loading ?? false,
      },
    },
  };
}

/** Applies one further page: merged by id, and the cursor moves on to its `nextCursor`. */
export function applyNextPage(
  s: UiState,
  key: string,
  res: ThreadPageResult,
  version: number,
): UiState {
  return {
    ...s,
    threads: mergeListedThreads(s, res.threads, version),
    threadPages: {
      ...s.threadPages,
      [key]: { cursor: res.nextCursor ?? null, beyondHead: true, loading: false },
    },
  };
}

/** Marks a page request as in flight (or done again after a failure). */
export function setPageLoading(s: UiState, key: string, loading: boolean): UiState {
  const prev = s.threadPages[key];
  if (prev === undefined) return s;
  return { ...s, threadPages: { ...s.threadPages, [key]: { ...prev, loading } } };
}

/**
 * Loads the page after the one held. Returns false when there is none, one is already in flight,
 * or the request failed (the cursor stays, so the next "Show more" retries).
 */
export async function loadNextThreadPage(
  store: ThreadPageStore,
  includeArchived: boolean,
): Promise<boolean> {
  const key = threadPageKey(includeArchived);
  const page = store.getState().threadPages[key];
  if (page === undefined || page.cursor === null || page.loading) return false;
  store.update((s) => setPageLoading(s, key, true));
  const version = store.version();
  try {
    const res = await store.call("threads.list", { includeArchived, cursor: page.cursor });
    store.update((s) => applyNextPage(s, key, res, version));
    return true;
  } catch {
    store.update((s) => setPageLoading(s, key, false));
    return false;
  }
}

/** Loads every remaining page, so a search can reach any thread. */
export async function loadAllThreadPages(
  store: ThreadPageStore,
  includeArchived: boolean,
): Promise<void> {
  const key = threadPageKey(includeArchived);
  while (store.getState().threadPages[key]?.cursor != null) {
    if (!(await loadNextThreadPage(store, includeArchived))) return;
  }
}
