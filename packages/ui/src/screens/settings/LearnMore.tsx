import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";

/**
 * A quiet disclosure for the long text a setting does not need up front: consent wording,
 * warnings, how a thing works. The summary is a plain-weight line, so a page of settings reads as
 * rows and not as paragraphs; the text opens in place.
 */
export function LearnMore({
  children,
  label,
  className,
}: {
  children: ReactNode;
  /** The summary line; "Learn more" by default. */
  label?: string;
  className?: string;
}): ReactElement {
  return (
    <details className={cn("group text-callout", className)}>
      <summary className="inline-flex cursor-default list-none items-center gap-1 rounded-sm text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3 transition-transform duration-short ease-standard group-open:rotate-90"
        />
        {label ?? t("settings.learnMore")}
      </summary>
      <div className="mt-1 flex flex-col gap-2 ps-4 text-label-secondary">{children}</div>
    </details>
  );
}
