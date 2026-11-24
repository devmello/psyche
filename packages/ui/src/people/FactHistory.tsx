import type { GraphFact } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { ProvenanceGlyph, sourceText } from "./glyphs.tsx";
import { useFactHistory } from "./hooks.ts";
import type { EntityView, FactView, GraphProvenance, SourceView } from "./types.ts";

/**
 * The History of one fact on a card (docs/memory/people-and-projects-2026.md §6.1): the current
 * value marked current, then every superseded value newest first, each with its date and source.
 * Loaded when the owner opens it, never on card load.
 */

/** Where a stored version came from, resolved against the card's own interactions (as adapt does). */
function sourceOfStored(fact: GraphFact, entity: EntityView): SourceView | null {
  for (const ref of fact.sources) {
    const interaction = entity.interactions.find((i) => i.id === ref);
    if (interaction) {
      return { kind: interaction.kind, link: interaction.link ?? null, at: interaction.occurredAt };
    }
    if (/^contact/i.test(ref)) return { kind: "contacts" };
  }
  return fact.provenance === "owner" ? { kind: "owner", at: fact.recordedAt } : null;
}

interface Version {
  value: string;
  evidence: string | null;
  provenance: GraphProvenance;
  source: SourceView | null;
  recordedAt: string;
}

function VersionRow({ version, current }: { version: Version; current: boolean }): ReactElement {
  const untrusted = version.provenance === "untrusted";
  const line = sourceText(version.source, untrusted) || formatDate(version.recordedAt);
  return (
    <li className="flex flex-col">
      <span className="flex flex-wrap items-baseline gap-2 text-body text-label-primary">
        {untrusted ? `“${version.evidence ?? version.value}”` : version.value}
        {current ? (
          <span className="text-callout text-label-tertiary">{t("people.history.current")}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-1 text-callout text-label-secondary">
        <ProvenanceGlyph provenance={version.provenance} />
        {line}
      </span>
    </li>
  );
}

export function FactHistory({
  entity,
  fact,
}: {
  entity: EntityView;
  fact: FactView;
}): ReactElement {
  const { facts, loading, error, reload } = useFactHistory(entity.id, fact.attribute, true);
  const attribute = t(`people.attr.${fact.attribute}`);
  const earlier = facts
    .filter((f) => f.id !== fact.id && f.supersededBy != null)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));

  return (
    <div className="mt-1 flex flex-col gap-1 border-s border-separator ps-2">
      <ol aria-label={t("people.history.list", { attribute })} className="flex flex-col gap-1">
        <VersionRow
          current
          version={{
            value: fact.value,
            evidence: fact.evidence ?? null,
            provenance: fact.provenance,
            source: fact.source ?? null,
            recordedAt: fact.recordedAt,
          }}
        />
        {earlier.map((f) => (
          <VersionRow
            key={f.id}
            current={false}
            version={{
              value: f.value,
              evidence: f.evidence ?? null,
              provenance: f.provenance,
              source: sourceOfStored(f, entity),
              recordedAt: f.recordedAt,
            }}
          />
        ))}
      </ol>
      {loading ? (
        <p className="text-callout text-label-secondary">{t("people.history.loading")}</p>
      ) : null}
      {error ? (
        <p className="flex flex-wrap items-center gap-2 text-callout text-label-secondary">
          {t("people.history.error")}
          <Button type="button" size="sm" variant="ghost" onClick={reload}>
            {t("people.history.retry")}
          </Button>
        </p>
      ) : null}
      {!loading && !error && earlier.length === 0 ? (
        <p className="text-callout text-label-secondary">{t("people.history.empty")}</p>
      ) : null}
    </div>
  );
}
