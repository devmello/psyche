import type { EntitySummary, GraphEntityKind } from "@psyche/protocol";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { toEntityView } from "./adapt.ts";
import type {
  EntityView,
  FactView,
  GraphFactAttribute,
  GraphLoopStatus,
  LoopView,
  ProjectStatus,
  WorkStatus,
} from "./types.ts";

/**
 * Gateway hooks for people and projects (`memory.entities.*`, `memory.loops.*`; PG0). Queries are
 * cached and reload when `memory.entity.updated`, `memory.loop.updated` or
 * `memory.suggestion.created` arrives (the store invalidates them).
 */

/** People and projects matching `q` for Search and ⌘K; nothing for an empty query. */
export function useEntitySearch(
  q: string,
  options: { kinds?: GraphEntityKind[]; limit?: number; enabled?: boolean } = {},
): { entities: EntitySummary[]; loading: boolean; error: string | null } {
  const query = q.trim();
  const enabled = (options.enabled ?? true) && query !== "";
  const res = useGatewayQuery(
    "memory.entities.search",
    {
      q: query,
      limit: options.limit ?? 8,
      ...(options.kinds ? { kinds: options.kinds } : {}),
    },
    { enabled },
  );
  return {
    entities: enabled ? (res.data?.entities ?? []) : [],
    loading: enabled && res.loading,
    error: enabled ? res.error : null,
  };
}

export interface EntityCardState {
  entity: EntityView | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  busy: boolean;
  setFact: (entity: EntityView, attribute: GraphFactAttribute, value: string) => void;
  retractFact: (entity: EntityView, fact: FactView) => void;
  updateLoop: (entity: EntityView, loop: LoopView, status: GraphLoopStatus) => void;
  setStatus: (entity: EntityView, status: ProjectStatus) => void;
  /** An assignment's status (§3.4): the owner's word, written as a `status` fact. */
  setWorkStatus: (entity: EntityView, status: WorkStatus) => void;
  /** A work item's due date; null clears it. */
  setDueAt: (entity: EntityView, dueAt: string | null) => void;
  /** Keep private: the item shows on its Memory page only (§4). */
  setPrivate: (entity: EntityView, on: boolean) => void;
  togglePin: (entity: EntityView) => void;
}

/** One card: `memory.entities.get` joined into a view, and the owner's writes. */
export function useEntityCard(id: string | null, now: number = Date.now()): EntityCardState {
  const call = useCall();
  const res = useGatewayQuery("memory.entities.get", { id: id ?? "" }, { enabled: id !== null });
  const [busy, setBusy] = useState(false);
  const entity = useMemo(
    () => (res.data && id !== null ? toEntityView({ detail: res.data, now }) : null),
    [res.data, id, now],
  );
  const write = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .then(() => res.reload())
      .catch((err: unknown) => {
        toast.error(t("people.writeFailed", { reason: describeError(err) }));
      })
      .finally(() => setBusy(false));
  };
  return {
    entity,
    loading: id !== null && res.loading,
    error: res.error,
    reload: res.reload,
    busy,
    setFact: (e, attribute, value) =>
      write(() =>
        call("memory.entities.facts.set", {
          entityId: e.id,
          attribute,
          value,
          source: { kind: "owner_edit" },
        }),
      ),
    retractFact: (_e, fact) =>
      write(() =>
        call("memory.entities.facts.retract", {
          factId: fact.id,
          source: { kind: "owner_feedback" },
        }),
      ),
    updateLoop: (_e, loop, status) =>
      write(() => call("memory.loops.update", { id: loop.id, status })),
    setStatus: (e, status) =>
      write(() =>
        call("memory.entities.update", {
          id: e.id,
          projectStatus: status,
          ...(res.data ? { etag: res.data.etag } : {}),
        }),
      ),
    setWorkStatus: (e, status) =>
      write(() =>
        call("memory.entities.facts.set", {
          entityId: e.id,
          attribute: "status",
          value: status,
          source: { kind: "owner_edit" },
        }),
      ),
    setDueAt: (e, dueAt) => write(() => call("memory.entities.update", { id: e.id, dueAt })),
    setPrivate: (e, on) => write(() => call("memory.entities.update", { id: e.id, private: on })),
    togglePin: (e) => write(() => call("memory.entities.update", { id: e.id, pinned: !e.pinned })),
  };
}
