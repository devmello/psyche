import { Newspaper } from "lucide-react";
import type { ReactElement } from "react";
import { SafeLink } from "../links/SafeLink.tsx";
import type { BlockOf } from "./types.ts";

/**
 * What a message was about (Feed "Ask about this"): a compact quoted card ahead of the question,
 * so the transcript keeps showing the article. The title and source come from fetched web content
 * (untrusted): plain text only, and the link goes through `SafeLink`.
 */
export function ContextCard({ block }: { block: BlockOf<"context"> }): ReactElement {
  const body = (
    <>
      <Newspaper className="mt-0.5 size-3.5 shrink-0 text-label-secondary" aria-hidden="true" />
      <span className="min-w-0">
        <span className="line-clamp-2 text-callout font-medium text-label-primary">
          {block.title}
        </span>
        {block.source ? (
          <span className="block truncate text-caption text-label-secondary">{block.source}</span>
        ) : null}
      </span>
    </>
  );
  const className =
    "my-1 flex items-start gap-2 rounded-md border-s-2 border-separator-strong bg-fill-tertiary py-1.5 ps-2 pe-3 text-start no-underline";
  return (
    <div data-testid="context-card">
      {block.url && /^https?:\/\//i.test(block.url) ? (
        <SafeLink href={block.url} className={className}>
          {body}
        </SafeLink>
      ) : (
        <div className={className}>{body}</div>
      )}
    </div>
  );
}
