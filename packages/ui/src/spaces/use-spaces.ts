import type { SpaceDetail, SpaceSummary } from "@psyche/protocol";
import { useMemo } from "react";
import { useGatewayQuery, useStore, useThreads } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";

/**
 * Spaces over `spaces.list` and `spaces.get` (docs/design/spaces-2026.md §4.2). Both are cached
 * reads: `space.updated` and `space.tracker.refreshed` mark them stale and they reload.
 */

/** The Spaces in `sort` order; `archived` lists the archived ones instead. */
export function useSpaces(options: { archived?: boolean; enabled?: boolean } = {}) {
  const q = useGatewayQuery(
    "spaces.list",
    options.archived === true ? { archived: true } : {},
    options.enabled === undefined ? {} : { enabled: options.enabled },
  );
  const spaces: readonly SpaceSummary[] = useMemo(
    () => [...(q.data?.spaces ?? [])].sort((a, b) => a.sort - b.sort),
    [q.data],
  );
  return { ...q, spaces };
}

/** One Space with its parts, or null while it loads or when it is gone. */
export function useSpace(spaceId: string) {
  const q = useGatewayQuery("spaces.get", { spaceId });
  return { ...q, detail: (q.data ?? null) as SpaceDetail | null };
}

/** The chats in a Space, newest first (the store's thread list is the source). */
export function useSpaceThreads(spaceId: string | null) {
  const { all, ...rest } = useThreads();
  const chats = useMemo(
    () =>
      spaceId === null
        ? []
        : all.filter((e) => e.thread.spaceId === spaceId && e.thread.archivedAt == null),
    [all, spaceId],
  );
  return { ...rest, all, chats };
}

/** The actions the Spaces UI shares: make one, start a chat in one, move chats. */
export function useSpaceActions() {
  const store = useStore();
  return useMemo(
    () => ({
      create: async (name: string, description?: string): Promise<string> => {
        const { space } = await store.call("spaces.create", {
          name,
          ...(description === undefined || description === "" ? {} : { description }),
        });
        return space.id;
      },
      /** A new chat in the Space; the empty one the owner already has there is reused. */
      newChatIn: async (spaceId: string): Promise<string> => {
        const { thread } = await store.call("threads.newChat", { kind: "side", spaceId });
        return thread.id;
      },
      moveThreads: (threadIds: string[], spaceId: string | null) =>
        store.call("spaces.threads.move", { threadIds, spaceId }),
    }),
    [store],
  );
}

/**
 * A row's second line, from code and never from untrusted text: the items due, the chats, then
 * when the Space was last active.
 */
export function spaceLine(space: SpaceSummary, now: number): string {
  const parts: string[] = [];
  if (space.counts.due > 0) parts.push(t("spaces.line.due", { n: space.counts.due }));
  if (space.counts.chats > 0) parts.push(t("spaces.line.chats", { n: space.counts.chats }));
  if (space.counts.trackers > 0 && parts.length < 2) {
    parts.push(t("spaces.line.trackers", { n: space.counts.trackers }));
  }
  if (space.lastActivityAt != null) {
    parts.push(t("spaces.line.active", { when: formatRelative(space.lastActivityAt, now) }));
  }
  return parts.length === 0 ? t("spaces.line.empty") : parts.join(" · ");
}

/** Newest activity first; a Space with none keeps its list order. */
export function byRecentActivity(spaces: readonly SpaceSummary[]): SpaceSummary[] {
  return [...spaces].sort((a, b) => {
    const at = a.lastActivityAt ?? "";
    const bt = b.lastActivityAt ?? "";
    return at === bt ? a.sort - b.sort : at < bt ? 1 : -1;
  });
}

export const spaceHref = (spaceId: string) => `/spaces/${spaceId}`;
