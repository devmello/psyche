import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { isMessageId, t } from "../../i18n/core.ts";
import { formatDate } from "../../lib/format.ts";
import { useSlots } from "../../slots.tsx";

/**
 * The read-only source panel (docs/roadmap/future-features.md §1, phase 2): the passage the index
 * holds for a document id, with its source and date, and, where the Mac has a safe way, a button
 * that opens the original (Mail for a message, Finder for a file in a granted folder).
 *
 * The text is what was indexed, often other people's words: plain text only, never markup or
 * links. The open button sends the document id to the host and nothing else; the host resolves
 * the Message-ID or path itself.
 */

function sourceName(source: string): string {
  const id = `everything.source.${source}`;
  return isMessageId(id) ? t(id) : source;
}

export function SourceViewer({ docId }: { docId: string }): ReactElement {
  const q = useGatewayQuery("search.document", { id: docId });
  const { openSource } = useSlots();
  const [opening, setOpening] = useState<"idle" | "busy" | "failed">("idle");
  const doc = q.data;

  if (doc === undefined) {
    return (
      <p className="text-callout text-label-secondary" role="status" data-testid="source-viewer">
        {q.error ? t("screens.search.source.failed") : t("screens.search.source.loading")}
      </p>
    );
  }

  const when = formatDate(new Date(doc.createdAt).toISOString());
  const meta =
    doc.source === "messages"
      ? t("screens.search.source.conversation", { date: when })
      : t("screens.search.source.from", { source: sourceName(doc.source), date: when });
  const canOpen = doc.open !== null && openSource !== undefined;

  return (
    <section
      aria-label={t("screens.search.source.label")}
      className="flex flex-col gap-1.5 rounded-md bg-fill-quaternary p-2"
      data-testid="source-viewer"
    >
      <p className="text-caption text-label-tertiary">{meta}</p>
      <p className="text-callout text-label-primary">{doc.title}</p>
      <pre
        className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-sans text-callout text-label-secondary"
        data-testid="source-text"
      >
        {doc.text}
      </pre>
      {doc.truncated ? (
        <p className="text-caption text-label-tertiary">{t("screens.search.source.truncated")}</p>
      ) : null}
      {doc.provenance === "untrusted" ? (
        <p className="text-caption text-label-tertiary">{t("screens.search.source.untrusted")}</p>
      ) : null}
      {canOpen ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={opening === "busy"}
          onClick={() => {
            setOpening("busy");
            // The id goes to the host; it resolves what to open itself (lib/source-open.ts).
            openSource(docId).then(
              (r) => setOpening(r === "none" ? "failed" : "idle"),
              () => setOpening("failed"),
            );
          }}
        >
          {doc.open === "mail"
            ? t("screens.search.source.openMail")
            : t("screens.search.source.revealFile")}
        </Button>
      ) : null}
      {opening === "failed" ? (
        <p className="text-caption text-label-secondary" role="status">
          {t("screens.search.source.openFailed")}
        </p>
      ) : null}
    </section>
  );
}
