import type { ReactElement, ReactNode } from "react";
import { Card, type CardAction } from "../blocks/card.tsx";
import { t } from "../i18n/core.ts";
import type { MessageId } from "../i18n/index.ts";

/** The Overview's section anchors, in page order (agent-overview-2026 §5.1). */
export const OVERVIEW_SECTIONS = [
  "now",
  "activity",
  "growth",
  "people",
  "built",
  "specialists",
  "upcoming",
  "recent",
] as const;
export type OverviewSectionId = (typeof OVERVIEW_SECTIONS)[number];

export const sectionTitle = (id: OverviewSectionId): string =>
  t(`overview.section.${id}` as MessageId);

export interface OverviewSectionProps {
  id: OverviewSectionId;
  /** Short text after the title ("Last 30 days"). */
  meta?: ReactNode;
  /** Up to two header actions ("See all"). */
  actions?: readonly CardAction[];
  /** The section's body; empty until its data PR lands, which shows the quiet empty line. */
  children?: ReactNode;
}

/**
 * One framed section of the Overview (§5.1): a `Card` with the section's title, `meta` and
 * actions, and the anchor `#<id>` for the jump bar. Sections are the only cards on the page and
 * never nest. Later PRs render their rows as the children.
 */
export function OverviewSection({
  id,
  meta,
  actions,
  children,
}: OverviewSectionProps): ReactElement {
  const title = sectionTitle(id);
  return (
    <div id={id} className="scroll-mt-16" data-testid={`overview-${id}`}>
      <Card
        label={title}
        variant="framed"
        className="my-0"
        title={title}
        animate={false}
        {...(meta === undefined ? {} : { meta })}
        {...(actions === undefined ? {} : { actions })}
      >
        {children ?? (
          <p className="text-callout text-label-tertiary">{t("overview.section.empty")}</p>
        )}
      </Card>
    </div>
  );
}
