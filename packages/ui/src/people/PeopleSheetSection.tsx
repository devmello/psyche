import type { GraphLoop } from "@psyche/protocol";
import { Search } from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { GroupedList } from "../components/page.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { useSlots } from "../slots.tsx";
import { toSuggestionView } from "./adapt.ts";
import { ConnectedEntityCard } from "./ConnectedEntityCard.tsx";
import { EntityRow } from "./EntityRow.tsx";
import { LoopRow } from "./LoopRow.tsx";
import { SuggestionCard } from "./SuggestionCard.tsx";
import type { EntityRef, LoopView } from "./types.ts";

/**
 * Soul & Memory → People & projects (docs/memory/people-and-projects-2026.md §6.5): a searchable
 * list with filter chips (People, Projects, Suggestions, Waiting on). A row opens the card in a
 * level-3 sheet, as the memory files do; `/agent/soul?entity=<id>` opens it directly.
 */

type Filter = "people" | "projects" | "suggestions" | "waiting";
const FILTERS: readonly Filter[] = ["people", "projects", "suggestions", "waiting"];

/** A loop row's view, with names from the graph's people and projects. */
function loopView(loop: GraphLoop, names: ReadonlyMap<string, EntityRef>): LoopView {
  const ref = (id: string | null | undefined) => (id == null ? null : (names.get(id) ?? null));
  return {
    id: loop.id,
    direction: loop.direction,
    text: loop.text,
    evidence: loop.evidence ?? null,
    counterpart: ref(loop.counterpartId),
    project: ref(loop.projectId),
    dueAt: loop.dueAt ?? null,
    status: loop.status,
    provenance: loop.provenance,
    source: null,
  };
}

export interface PeopleSheetSectionProps {
  /** Opens this entity's card on mount (`?entity=`). */
  initialEntity?: string;
  now?: number;
}

export function PeopleSheetSection({
  initialEntity,
  now = Date.now(),
}: PeopleSheetSectionProps): ReactElement {
  const call = useCall();
  const { openExternal } = useSlots();
  const searchId = useId();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("people");
  const [open, setOpen] = useState<string | null>(initialEntity ?? null);
  const [busy, setBusy] = useState(false);

  const all = useGatewayQuery("memory.entities.search", { q: "", limit: 100 });
  const found = useGatewayQuery(
    "memory.entities.search",
    {
      q: q.trim(),
      kinds: filter === "projects" ? ["project"] : ["person", "org", "place"],
      limit: 50,
    },
    { enabled: filter === "people" || filter === "projects" },
  );
  const suggestions = useGatewayQuery(
    "memory.entities.suggestions",
    {},
    { enabled: filter === "suggestions" },
  );
  const waiting = useGatewayQuery(
    "memory.loops.list",
    { direction: "waiting_on", status: ["open"] },
    { enabled: filter === "waiting" },
  );
  const names = useMemo(
    () =>
      new Map(
        (all.data?.entities ?? []).map(
          (e) => [e.id, { id: e.id, kind: e.kind, name: e.name }] as const,
        ),
      ),
    [all.data],
  );
  const openName = open ? (names.get(open)?.name ?? "") : "";

  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .catch((err: unknown) => toast.error(t("people.writeFailed", { reason: describeError(err) })))
      .finally(() => setBusy(false));
  };

  let body: ReactElement;
  if (filter === "suggestions") {
    const list = suggestions.data?.suggestions ?? [];
    body =
      list.length === 0 ? (
        <p className="px-3 py-2 text-body text-label-secondary">
          {t("people.sheet.noSuggestions")}
        </p>
      ) : (
        <div className="flex flex-col gap-2 p-2">
          {list.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={toSuggestionView(s, names)}
              busy={busy}
              onAnswer={(_v, answer) =>
                act(() => call("memory.entities.suggestions.answer", { id: s.id, answer }))
              }
            />
          ))}
        </div>
      );
  } else if (filter === "waiting") {
    const loops = waiting.data?.loops ?? [];
    body =
      loops.length === 0 ? (
        <p className="px-3 py-2 text-body text-label-secondary">{t("people.empty.loops")}</p>
      ) : (
        <>
          {loops.map((l) => (
            <LoopRow
              key={l.id}
              loop={loopView(l, names)}
              now={now}
              busy={busy}
              onUpdate={(loop, status) =>
                act(() => call("memory.loops.update", { id: loop.id, status }))
              }
              {...(openExternal ? { onOpenLink: (link: string) => void openExternal(link) } : {})}
            />
          ))}
        </>
      );
  } else {
    const rows = (found.data?.entities ?? []).filter((e) => !e.isOwner);
    body =
      rows.length === 0 && !found.loading ? (
        <p className="px-3 py-2 text-body text-label-secondary">
          {q.trim() === ""
            ? t("people.sheet.empty")
            : t("people.sheet.nothing", { query: q.trim() })}
        </p>
      ) : (
        <div className="flex flex-col p-1">
          {rows.map((e) => (
            <EntityRow key={e.id} entity={e} now={now} onOpen={(x) => setOpen(x.id)} />
          ))}
        </div>
      );
  }

  return (
    <section aria-labelledby={`${searchId}-title`} className="flex flex-col gap-2">
      <h3 id={`${searchId}-title`} className="px-1 text-title-3 text-label-primary">
        {t("people.sheet.title")}
      </h3>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-label-tertiary"
        />
        <label htmlFor={searchId} className="sr-only">
          {t("people.sheet.search")}
        </label>
        <Input
          id={searchId}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (filter !== "people" && filter !== "projects") setFilter("people");
          }}
          placeholder={t("people.sheet.search")}
          className="ps-8"
        />
      </div>
      <SegmentedRadio
        label={t("people.sheet.show")}
        value={filter}
        onChange={setFilter}
        className="self-start"
        options={FILTERS.map((f) => ({ value: f, label: t(`people.sheet.filter.${f}`) }))}
      />
      <GroupedList>{body}</GroupedList>

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="flex max-h-[85vh] w-[min(640px,calc(100vw-2rem))] max-w-none flex-col gap-3 overflow-y-auto sm:max-w-none">
          <DialogHeader>
            <DialogTitle className="sr-only">{openName || t("people.sheet.title")}</DialogTitle>
          </DialogHeader>
          {open !== null ? (
            <ConnectedEntityCard
              key={open}
              id={open}
              now={now}
              className="bg-transparent p-0 shadow-none"
              onOpenEntity={setOpen}
              onForgotten={() => setOpen(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
