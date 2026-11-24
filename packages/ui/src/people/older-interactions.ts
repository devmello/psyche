import type { GraphInteraction, MethodResult } from "@psyche/protocol";
import { useState } from "react";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { describeError } from "../i18n/errors.ts";
import type { OlderInteractions } from "./EntityCard.tsx";
import type { InteractionView } from "./types.ts";

const PAGE = 10;
/** Pages read by one click while none of them has an unseen row (bounded, so a click stays quick). */
const MAX_PAGES_PER_CLICK = 5;

/** One interaction from `memory.entities.interactions`, shaped as a Recent row. */
export function olderView(i: GraphInteraction): InteractionView {
  const untrusted =
    (i.kind === "mail" || i.kind === "message" || i.kind === "call" || i.kind === "meeting") &&
    i.direction !== "out";
  return {
    id: i.id,
    kind: i.kind,
    occurredAt: i.occurredAt,
    direction: i.direction,
    link: i.link ?? null,
    subject: i.subject ?? null,
    ...(i.gist == null
      ? {}
      : {
          gist: i.gist,
          ...(i.gistDocId === undefined ? {} : { gistDocId: i.gistDocId }),
          gistUntrusted: untrusted,
        }),
    // This method returns entity ids, not names, so an older row without a subject shows its app.
    with: [],
  };
}

/**
 * "Show older" for a person's Recent list. The card already shows `shown` (the newest rows); this
 * reads `memory.entities.interactions` from the start and appends what is not shown yet, in the
 * method's own order. The method pages by an opaque cursor, so paging starts from the first page.
 */
export function useOlderInteractions({
  entityId,
  shown,
  enabled,
}: {
  entityId: string;
  /** The ids the card shows; these are never appended again. */
  shown: ReadonlySet<string>;
  enabled: boolean;
}): OlderInteractions {
  const call = useCall();
  const first = useGatewayQuery(
    "memory.entities.interactions",
    { id: entityId, limit: PAGE },
    { enabled },
  );
  const [appended, setAppended] = useState<InteractionView[]>([]);
  // `undefined`: the first page's rows are not all handed out yet; `null`: the method has no more.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seen = new Set<string>([...shown, ...appended.map((r) => r.id)]);
  const firstPage = first.data;
  const firstUnseen =
    cursor === undefined ? (firstPage?.interactions ?? []).filter((i) => !seen.has(i.id)) : [];
  const hasMore =
    enabled &&
    (cursor === undefined
      ? firstPage !== undefined && (firstUnseen.length > 0 || firstPage.nextCursor != null)
      : cursor !== null);

  const more = async () => {
    setLoading(true);
    setError(null);
    try {
      const taken = new Set<string>(seen);
      const picked: GraphInteraction[] = [];
      let next: string | null;
      if (cursor === undefined) {
        next = firstPage?.nextCursor ?? null;
        for (const i of firstPage?.interactions ?? []) {
          if (taken.has(i.id)) continue;
          taken.add(i.id);
          picked.push(i);
        }
      } else {
        next = cursor;
      }
      let pages = 0;
      while (picked.length === 0 && next !== null && pages < MAX_PAGES_PER_CLICK) {
        const res: MethodResult<"memory.entities.interactions"> = await call(
          "memory.entities.interactions",
          { id: entityId, cursor: next, limit: PAGE },
        );
        pages += 1;
        next = res.nextCursor ?? null;
        for (const i of res.interactions) {
          if (taken.has(i.id)) continue;
          taken.add(i.id);
          picked.push(i);
        }
      }
      setAppended((rows) => [...rows, ...picked.map(olderView)]);
      setCursor(next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  return {
    rows: appended,
    hasMore,
    loading,
    error,
    onMore: () => void more(),
  };
}
