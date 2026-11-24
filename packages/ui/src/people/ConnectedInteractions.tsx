import type { MethodResult } from "@psyche/protocol";
import { ExternalLink } from "lucide-react";
import { type ReactElement, useState } from "react";
import { GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatDate } from "../lib/format.ts";
import { useOpenLink } from "../links/LinkPrompt.tsx";
import { INTERACTION_ICON } from "./glyphs.tsx";

type Interaction = MethodResult<"memory.entities.interactions">["interactions"][number];

const PAGE = 10;
/** Third-party subjects are cut to this many characters before they reach the screen. */
const SUBJECT_MAX = 120;

/**
 * A subject, cut to `max` characters (by code point, so an emoji is never split). The text stays
 * plain: React renders it as a text node, never as markup.
 */
export function clipSubject(text: string, max = SUBJECT_MAX): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * A person's recent interactions, newest first, paged from `memory.entities.interactions`: what
 * it was (the subject line, plain text), which app, which way, when, and a link to the source.
 * Headers and links only, never message bodies or gists.
 */
export function ConnectedInteractions({
  entityId,
  name,
}: {
  entityId: string;
  name: string;
}): ReactElement | null {
  const call = useCall();
  const openLink = useOpenLink();
  const first = useGatewayQuery("memory.entities.interactions", { id: entityId, limit: PAGE });
  const [older, setOlder] = useState<{ items: Interaction[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const head = first.data?.interactions ?? [];
  const seen = new Set(head.map((i) => i.id));
  const items = [...head, ...(older?.items ?? []).filter((i) => !seen.has(i.id))];
  const next = older ? older.next : (first.data?.nextCursor ?? null);

  const more = () => {
    if (next === null) return;
    setLoadingMore(true);
    setMoreError(null);
    call("memory.entities.interactions", { id: entityId, cursor: next, limit: PAGE })
      .then((res) =>
        setOlder((o) => ({
          items: [...(o?.items ?? []), ...res.interactions],
          next: res.nextCursor ?? null,
        })),
      )
      .catch((err: unknown) => setMoreError(describeError(err)))
      .finally(() => setLoadingMore(false));
  };

  if (first.loading && first.data === undefined) return null;
  return (
    <GroupedList title={t("people.interactions.title")}>
      {first.error && first.data === undefined ? (
        <p className="px-3 py-2 text-body text-label-secondary">
          {t("people.interactions.error", { reason: first.error })}
        </p>
      ) : null}
      {first.data !== undefined && items.length === 0 ? (
        <p className="px-3 py-2 text-body text-label-secondary">
          {t("people.interactions.empty", { name })}
        </p>
      ) : null}
      {items.map((it) => {
        const Icon = INTERACTION_ICON[it.kind];
        const app = t(`people.app.${it.kind}`);
        const link = it.link ?? null;
        const subject = it.subject ? clipSubject(it.subject) : app;
        return (
          <div
            key={it.id}
            data-testid="interaction-row"
            className="relative flex min-h-9 items-center gap-3 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <Icon className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body text-label-primary">{subject}</span>
              <span className="text-callout text-label-secondary">
                {t(`people.recent.${it.direction}`)} · {app} · {formatDate(it.occurredAt)}
              </span>
            </div>
            {link ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="shrink-0 text-label-secondary"
                aria-label={t("people.recent.open", { app })}
                title={t("people.recent.open", { app })}
                onClick={() => openLink(link)}
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        );
      })}
      {moreError ? (
        <p className="px-3 py-1.5 text-callout text-label-secondary">
          {t("people.interactions.error", { reason: moreError })}
        </p>
      ) : null}
      {next !== null ? (
        <div className="px-3 py-1.5">
          <Button type="button" size="sm" variant="ghost" disabled={loadingMore} onClick={more}>
            {loadingMore ? t("people.interactions.loadingMore") : t("people.interactions.more")}
          </Button>
        </div>
      ) : null}
    </GroupedList>
  );
}
