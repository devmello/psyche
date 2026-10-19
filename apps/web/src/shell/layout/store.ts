import type { KeyValueStore } from "../platform.ts";
import {
  emptyLayout,
  type LayoutAction,
  type LayoutEnv,
  type LayoutState,
  type PaneGroup,
  type PaneInstance,
} from "./model.ts";
import { applyLayoutAction, type LayoutOutcome, normalizeLayout } from "./reducer.ts";
import { applyViewCommand, type ViewCommandOutcome } from "./view-commands.ts";

/**
 * Per-thread layouts persisted under `psyche.layout.v1.<threadId>`. Reads are cached so
 * `forThread` returns a stable reference between changes, as `useSyncExternalStore` requires:
 *
 *   useSyncExternalStore((cb) => store.subscribeThread(id, cb), () => store.forThread(id))
 */

export const LAYOUT_KEY_PREFIX = "psyche.layout.v1.";

export function layoutStorageKey(threadId: string): string {
  return `${LAYOUT_KEY_PREFIX}${threadId}`;
}

export interface LayoutStoreOptions {
  /**
   * Keep panes that were popped out when the layout was saved. Default false: pop-out windows do
   * not survive a reload, so their panes come back docked.
   */
  restorePopped?: boolean;
}

export interface LayoutStore {
  forThread(threadId: string): LayoutState;
  dispatch(threadId: string, action: LayoutAction, env: LayoutEnv): LayoutState;
  /** `dispatch` that also says which pane the action resolved to. */
  apply(threadId: string, action: LayoutAction, env: LayoutEnv): LayoutOutcome;
  /** Applies a `view.command` to `args.threadId` (view.open) or else `fallbackThreadId`. */
  applyViewCommand(
    payload: unknown,
    fallbackThreadId: string,
    env: LayoutEnv,
  ): ViewCommandOutcome & { threadId: string };
  replace(threadId: string, state: LayoutState): void;
  /** Called with the thread id after any thread's layout changes. */
  subscribe(listener: (threadId: string) => void): () => void;
  subscribeThread(threadId: string, listener: () => void): () => void;
}

/** Wide enough that loading never merges groups or clamps sizes (dispatch re-fits to the window). */
const LOAD_WIDTH = { width: Number.POSITIVE_INFINITY };

export function createLayoutStore(
  storage: KeyValueStore,
  options: LayoutStoreOptions = {},
): LayoutStore {
  const cache = new Map<string, LayoutState>();
  const listeners = new Set<(threadId: string) => void>();

  const forThread = (threadId: string): LayoutState => {
    const cached = cache.get(threadId);
    if (cached !== undefined) return cached;
    let raw: string | null = null;
    try {
      raw = storage.get(layoutStorageKey(threadId));
    } catch {
      raw = null;
    }
    const state = parseLayout(raw, threadId, options);
    cache.set(threadId, state);
    return state;
  };

  const commit = (threadId: string, state: LayoutState): void => {
    if (cache.get(threadId) === state) return;
    cache.set(threadId, state);
    try {
      storage.set(layoutStorageKey(threadId), JSON.stringify(state));
    } catch {
      // the in-memory copy still serves this session
    }
    for (const listener of [...listeners]) {
      try {
        listener(threadId);
      } catch (err) {
        console.error("layout listener failed", err);
      }
    }
  };

  const apply = (threadId: string, action: LayoutAction, env: LayoutEnv): LayoutOutcome => {
    const out = applyLayoutAction(forThread(threadId), action, env);
    if (out.changed) commit(threadId, out.state);
    return out;
  };

  return {
    forThread,
    apply,
    dispatch: (threadId, action, env) => apply(threadId, action, env).state,
    applyViewCommand(payload, fallbackThreadId, env) {
      const args =
        typeof payload === "object" && payload !== null
          ? (payload as { args?: unknown }).args
          : undefined;
      const argThread =
        typeof args === "object" && args !== null
          ? (args as { threadId?: unknown }).threadId
          : undefined;
      const threadId =
        typeof argThread === "string" && argThread !== "" ? argThread : fallbackThreadId;
      const out = applyViewCommand(forThread(threadId), payload, env);
      if (out.ok && out.changed) commit(threadId, out.state);
      return { ...out, threadId };
    },
    replace(threadId, state) {
      commit(threadId, normalizeLayout({ ...state, threadId }, LOAD_WIDTH));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeThread(threadId, listener) {
      const wrapped = (changed: string) => {
        if (changed === threadId) listener();
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
}

// --- Parsing --------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

function parsePane(v: unknown): PaneInstance | null {
  if (!isRecord(v)) return null;
  const paneId = str(v.paneId);
  const pane = v.pane;
  if (paneId === undefined || typeof pane !== "string") return null;
  const kinds = [
    "browser",
    "terminal",
    "files",
    "editor",
    "diff",
    "plan",
    "tasks",
    "subagents",
    "artifact",
    "vm",
  ] as const;
  const kind = kinds.find((k) => k === pane);
  if (kind === undefined) return null;
  const out: PaneInstance = {
    paneId,
    pane: kind,
    target: typeof v.target === "string" ? v.target : null,
    threadId: typeof v.threadId === "string" ? v.threadId : null,
    openerPaneId: typeof v.openerPaneId === "string" ? v.openerPaneId : null,
    createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date(0).toISOString(),
  };
  const taskId = str(v.taskId);
  const artifactId = str(v.artifactId);
  if (taskId !== undefined) out.taskId = taskId;
  if (artifactId !== undefined) out.artifactId = artifactId;
  if (typeof v.title === "string") out.title = v.title;
  return out;
}

function parseGroup(v: unknown, i: number): PaneGroup | null {
  if (!isRecord(v)) return null;
  const paneIds = strings(v.paneIds);
  const first = paneIds[0];
  if (first === undefined) return null;
  return {
    groupId: str(v.groupId) ?? `g_r${i}`,
    paneIds,
    activePaneId: str(v.activePaneId) ?? first,
  };
}

/**
 * Parses a persisted layout. Corrupt JSON, an unknown version or a wrong shape yields an empty
 * layout; individually bad panes / groups are dropped and the rest repaired.
 */
export function parseLayout(
  json: string | null,
  threadId: string,
  options: LayoutStoreOptions = {},
): LayoutState {
  if (json === null || json === "") return emptyLayout(threadId);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyLayout(threadId);
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.panes)) {
    return emptyLayout(threadId);
  }
  const panes = raw.panes.flatMap((p) => {
    const parsed = parsePane(p);
    return parsed === null ? [] : [parsed];
  });
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  const rawSizes = Array.isArray(raw.sizes) ? raw.sizes : [];
  const groups: PaneGroup[] = [];
  const sizes: number[] = [];
  rawGroups.forEach((g, i) => {
    const parsed = parseGroup(g, i);
    if (parsed === null) return;
    groups.push(parsed);
    const size = rawSizes[i];
    sizes.push(typeof size === "number" ? size : 0);
  });
  const state: LayoutState = {
    version: 1,
    threadId,
    panes,
    groups,
    sizes,
    focusedPaneId: str(raw.focusedPaneId) ?? null,
    // Unlisted popped panes are orphans, which normalization docks in the last group.
    popped: options.restorePopped === true ? strings(raw.popped) : [],
    chatFraction: typeof raw.chatFraction === "number" ? raw.chatFraction : Number.NaN,
  };
  try {
    return normalizeLayout(state, LOAD_WIDTH);
  } catch {
    return emptyLayout(threadId);
  }
}
