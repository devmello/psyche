import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { ProvenanceGlyph, sourceText } from "./glyphs.tsx";
import { revealOnHover } from "./LoopRow.tsx";
import type { FactView, GraphEntityKind, GraphFactAttribute } from "./types.ts";

/** Attributes the owner may set by hand, per kind (spec §4.3; birthday and relations included). */
export const OWNER_ATTRIBUTES: Record<
  "person" | "project" | "course" | "assignment",
  readonly GraphFactAttribute[]
> = {
  person: [
    "role",
    "title",
    "employer",
    "team",
    "email_pref",
    "timezone",
    "city",
    "birthday",
    "relationship_to_owner",
    "preference",
    "note",
  ],
  project: ["next_step", "deadline", "budget_note", "note"],
  // Memory for everything (docs/design/memory-everything-2026.md §2.3, §6.3). The status is not
  // here: it has its own control, and the due date its own editor.
  course: [
    "course_code",
    "term",
    "meets",
    "next_step",
    "stopped_at",
    "progress",
    "blocked_on",
    "deadline",
    "note",
  ],
  assignment: ["next_step", "stopped_at", "progress", "blocked_on", "deadline", "note"],
};

/** The attributes the owner may add by hand to an entity of this kind (a course has its own set). */
export function attributesFor(
  kind: GraphEntityKind,
  projectType?: "project" | "course" | null,
): readonly GraphFactAttribute[] {
  if (kind === "assignment") return OWNER_ATTRIBUTES.assignment;
  if (kind === "project")
    return projectType === "course" ? OWNER_ATTRIBUTES.course : OWNER_ATTRIBUTES.project;
  return OWNER_ATTRIBUTES.person;
}

export interface FactRowProps {
  fact: FactView;
  /** Saves an owner value; the old fact is superseded, not deleted (spec §6.1). */
  onSet?: (fact: FactView, value: string) => void;
  /** "This is wrong": retracts it and records a correction. */
  onRetract?: (fact: FactView) => void;
  busy?: boolean;
  /** Older than the item's freshness window (§3.6): "may be out of date". */
  stale?: boolean;
  /** The group's own title already says what it is: keep the attribute for screen readers only. */
  hideAttribute?: boolean;
}

/**
 * One fact (spec §6.5): the attribute, its value, a provenance glyph and its source. A claim from
 * someone else's message is shown as their words, never as a plain fact. "Edit" and "This is
 * wrong" appear on hover or focus.
 */
export function FactRow({
  fact,
  onSet,
  onRetract,
  busy = false,
  stale = false,
  hideAttribute = false,
}: FactRowProps): ReactElement {
  const labelId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.value);
  const untrusted = fact.provenance === "untrusted";
  const attribute = t(`people.attr.${fact.attribute}`);
  const source = sourceText(fact.source, untrusted);

  if (editing) {
    return (
      <form
        className="relative flex min-h-9 items-center gap-2 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
        onSubmit={(e) => {
          e.preventDefault();
          const value = draft.trim();
          if (value !== "" && value !== fact.value) onSet?.(fact, value);
          setEditing(false);
        }}
      >
        <span
          id={labelId}
          className={cn(
            "shrink-0 text-body text-label-secondary",
            hideAttribute ? "sr-only" : "w-28",
          )}
        >
          {attribute}
        </span>
        <Input
          autoFocus
          aria-labelledby={labelId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(fact.value);
              setEditing(false);
            }
          }}
          className="h-7 min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={busy || draft.trim() === ""}>
          {t("people.fact.save")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(fact.value);
            setEditing(false);
          }}
        >
          {t("people.fact.cancel")}
        </Button>
      </form>
    );
  }

  return (
    <div className="group/row relative flex min-h-9 items-start gap-3 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden">
      <span
        id={labelId}
        className={cn(
          "shrink-0 pt-px text-body text-label-secondary",
          hideAttribute ? "sr-only" : "w-28",
        )}
      >
        {attribute}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        {untrusted ? (
          <span className="text-body text-label-primary">“{fact.evidence ?? fact.value}”</span>
        ) : (
          <span className="text-body text-label-primary">{fact.value}</span>
        )}
        <span className="flex items-center gap-1 text-callout text-label-secondary">
          <ProvenanceGlyph provenance={fact.provenance} />
          {source}
          {stale ? (
            <span className="text-label-tertiary">
              {source ? " · " : ""}
              {t("work.fact.stale")}
            </span>
          ) : null}
        </span>
      </div>
      <span
        className={cn(
          "absolute end-1.5 top-1 flex items-center gap-0.5 rounded-md bg-surface-raised",
          revealOnHover,
        )}
      >
        {onSet ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t("people.fact.editLabel", { attribute })}
            onClick={() => {
              setDraft(untrusted ? "" : fact.value);
              setEditing(true);
            }}
          >
            {t("people.fact.edit")}
          </Button>
        ) : null}
        {onRetract ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-describedby={labelId}
            onClick={() => onRetract(fact)}
          >
            {t("people.fact.wrong")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/** "Add a fact": pick an attribute from the allowlist, type the value (an owner fact). */
export function AddFactRow({
  kind,
  projectType,
  onAdd,
  busy = false,
}: {
  kind: GraphEntityKind;
  projectType?: "project" | "course" | null;
  onAdd: (attribute: GraphFactAttribute, value: string) => void;
  busy?: boolean;
}): ReactElement {
  const attributes = attributesFor(kind, projectType);
  const [open, setOpen] = useState(false);
  const [attribute, setAttribute] = useState<GraphFactAttribute>(attributes[0] ?? "note");
  const [value, setValue] = useState("");
  const attrId = useId();
  const valueId = useId();
  const row =
    "relative flex min-h-9 items-center gap-2 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden";

  if (!open) {
    return (
      <div className={row}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ms-2.5 text-accent-11"
          onClick={() => setOpen(true)}
        >
          {t("people.fact.add")}
        </Button>
      </div>
    );
  }
  return (
    <form
      className={row}
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() === "") return;
        onAdd(attribute, value.trim());
        setValue("");
        setOpen(false);
      }}
    >
      <label htmlFor={attrId} className="sr-only">
        {t("people.fact.attribute")}
      </label>
      <NativeSelect
        id={attrId}
        size="sm"
        value={attribute}
        onChange={(e) => {
          const next = attributes.find((a) => a === e.target.value);
          if (next) setAttribute(next);
        }}
      >
        {attributes.map((a) => (
          <option key={a} value={a}>
            {t(`people.attr.${a}`)}
          </option>
        ))}
      </NativeSelect>
      <label htmlFor={valueId} className="sr-only">
        {t("people.fact.value")}
      </label>
      <Input
        id={valueId}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 min-w-0 flex-1"
      />
      <Button type="submit" size="sm" disabled={busy || value.trim() === ""}>
        {t("people.fact.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {t("people.fact.cancel")}
      </Button>
    </form>
  );
}
