import type { EntitySummary, GraphWorkStatus } from "@psyche/protocol";
import { CalendarClock, Plus } from "lucide-react";
import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { usePersona } from "../slots.tsx";
import { entityHref } from "./kinds.ts";
import { WorkRow } from "./WorkRow.tsx";
import { DUE_GROUPS, groupWork, parseQuickAdd } from "./work.ts";
import { useAssignments, useProjects, useWorkWrites } from "./work-hooks.ts";

/**
 * Quick add (§6.2): one line, "Lab report, CHEM 1B, Fri". It says what it understood before it
 * saves: the title, the course it found (or did not), and the day. A course is found by name here
 * and by alias through the Gateway's search.
 */
export function QuickAdd({
  now,
  parent: fixedParent,
  initialText = "",
  onAdded,
  onClose,
}: {
  now: number;
  /** A line already typed (a story shows what the form understood). */
  initialText?: string;
  /** Adding from a course's own page: the assignment belongs to it, whatever the text says. */
  parent?: { id: string; name: string };
  onAdded?: (id: string) => void;
  onClose: () => void;
}): ReactElement {
  const inputId = useId();
  const previewId = useId();
  const [text, setText] = useState(initialText);
  const { projects } = useProjects();
  const writes = useWorkWrites();
  const parse = useMemo(
    () =>
      parseQuickAdd(
        text,
        projects.map((p) => ({ id: p.id, name: p.name })),
        now,
      ),
    [text, projects, now],
  );
  const hint = fixedParent ? null : (parse?.unmatched ?? null);
  const byAlias = useGatewayQuery(
    "memory.entities.search",
    { q: hint ?? "", kinds: ["project"], limit: 3 },
    { enabled: hint !== null },
  );
  const aliasHits = hint === null ? [] : (byAlias.data?.entities ?? []).filter((e) => !e.isOwner);
  const parent =
    fixedParent ?? parse?.parent ?? (aliasHits.length === 1 ? (aliasHits[0] ?? null) : null);

  const preview: string[] = [];
  if (parse) {
    preview.push(parse.title);
    if (parent) preview.push(parent.name);
    if (parse.dueAt)
      preview.push(
        t("work.add.dueOn", {
          date: activeI18n().date(parse.dueAt, {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
        }),
      );
  }
  const noParent = parse !== null && parent === null && hint !== null && !byAlias.loading;

  const submit = async () => {
    if (!parse) return;
    const id = await writes.addAssignment({
      title: parse.title,
      dueAt: parse.dueAt,
      parentId: parent?.id ?? null,
    });
    if (id === null) return;
    toast(t("work.add.added", { title: parse.title }));
    setText("");
    onAdded?.(id);
    onClose();
  };

  return (
    <form
      aria-label={t("work.add.label")}
      className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3 shadow-elevation-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <label htmlFor={inputId} className="text-body text-label-primary">
        {t("work.add.label")}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          autoFocus
          value={text}
          aria-describedby={previewId}
          placeholder={fixedParent ? t("work.add.placeholderChild") : t("work.add.placeholder")}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={writes.busy || parse === null}>
          {t("work.add.submit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t("work.add.cancel")}
        </Button>
      </div>
      <p
        id={previewId}
        aria-live="polite"
        data-testid="quick-add-preview"
        className="min-h-5 text-callout text-label-secondary"
      >
        {parse === null ? t("work.add.hint") : preview.join(" · ")}
        {noParent ? (
          <span className="block text-label-tertiary">
            {t("work.add.noParent", { name: hint ?? "" })}
          </span>
        ) : null}
      </p>
    </form>
  );
}

/**
 * Work due (§6.2): assignments grouped Past due, This week, Later, No date and Done (last 14
 * days). Each row shows its parent, due date, status and stale mark, with a one-tap Done; Add
 * opens the one-line form. Amber marks only Past due, the group that needs the owner.
 */
export function WorkDueTab({
  now,
  onNavigate,
}: {
  now: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  const persona = usePersona();
  const { assignments, loading } = useAssignments();
  const writes = useWorkWrites();
  const [adding, setAdding] = useState(false);
  // Closed in this view: they stay in Done even when their date is older than 14 days.
  const [closedHere, setClosedHere] = useState<ReadonlySet<string>>(new Set());
  const addButton = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);
  useEffect(() => {
    if (wasAdding.current && !adding) addButton.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  const groups = useMemo(
    () => groupWork(assignments, now, closedHere),
    [assignments, now, closedHere],
  );
  const empty = DUE_GROUPS.every((g) => groups[g].length === 0);

  const setStatus = (item: EntitySummary, status: GraphWorkStatus) => {
    void writes.setStatus(item, status).then((ok) => {
      if (ok && (status === "done" || status === "dropped"))
        setClosedHere((s) => new Set(s).add(item.id));
    });
  };

  return (
    <section
      aria-label={t("memory.page.kind.due")}
      data-testid="memory-due"
      className="flex flex-col gap-6"
    >
      {adding ? (
        <QuickAdd now={now} onClose={() => setAdding(false)} />
      ) : (
        <div className="flex justify-end">
          <Button
            ref={addButton}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" />
            {t("work.add.button")}
          </Button>
        </div>
      )}
      {empty && !loading ? (
        <EmptyState icon={CalendarClock} className="pt-[4vh]">
          <span className="block text-headline text-label-primary">
            {t("memory.page.due.title")}
          </span>
          {t("memory.page.due.body", { persona: persona.name })}
        </EmptyState>
      ) : null}
      {DUE_GROUPS.map((g) =>
        groups[g].length === 0 ? null : (
          <ScreenSection
            key={g}
            id={`memory-due-${g.replace("_", "-")}`}
            title={t(`work.group.${g}`)}
            meta={String(groups[g].length)}
            needsYou={g === "past_due"}
          >
            <GroupedList>
              {groups[g].map((item) => (
                <WorkRow
                  key={item.id}
                  item={item}
                  now={now}
                  busy={writes.busy}
                  onOpen={(id) => onNavigate(entityHref(id))}
                  onSetStatus={setStatus}
                />
              ))}
            </GroupedList>
          </ScreenSection>
        ),
      )}
    </section>
  );
}
