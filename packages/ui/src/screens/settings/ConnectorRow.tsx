import { ArrowLeft, ChevronRight } from "lucide-react";
import { Children, type ReactElement, type ReactNode, useContext, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { GROUP_ROWS, InPageContext, StatusChip, type Tone } from "./shared.tsx";

/** One level under the pane's title: an h3 on its own, an h4 inside a page of panes. */
export function useSubheading(): "h3" | "h4" {
  return useContext(InPageContext) ? "h4" : "h3";
}

/**
 * The Connectors page's one row: icon, name, a line of context, a short status and one action.
 * The row opens the connector's detail; a row that needs the owner also carries the one button
 * that fixes it. Everything else (capabilities, tools, trust, logs) lives in the detail.
 */

export interface RowFix {
  label: string;
  /** Names the connector for a screen reader ("Sign in again to Outlook"). */
  ariaLabel?: string;
  onClick: () => void;
}

export function ConnectorRow({
  name,
  icon,
  subtitle,
  status,
  fix,
  onOpen,
}: {
  name: string;
  icon: ReactNode;
  subtitle: ReactNode;
  status?: { tone: Tone; label: string } | null;
  fix?: RowFix | null;
  onOpen: () => void;
}): ReactElement {
  return (
    <article aria-label={name} className="flex items-center gap-2">
      <button
        type="button"
        aria-label={t("settings.connectors.page.open", { name })}
        onClick={onOpen}
        className="-my-1 flex min-w-0 flex-1 cursor-default items-center gap-3 rounded-md py-1 text-start outline-none transition-colors duration-(--duration-micro) hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
      >
        {icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-headline text-label-primary">{name}</span>
          <span className="text-callout break-words text-label-secondary [overflow-wrap:anywhere]">
            {subtitle}
          </span>
        </span>
        {status ? <StatusChip tone={status.tone}>{status.label}</StatusChip> : null}
        {fix ? null : (
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-label-tertiary rtl:rotate-180"
          />
        )}
      </button>
      {fix ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={fix.onClick}
          {...(fix.ariaLabel ? { "aria-label": fix.ariaLabel } : {})}
        >
          {fix.label}
        </Button>
      ) : null}
    </article>
  );
}

/** A titled list of rows. `attention` tints it amber: the rows in it need the owner. */
export function RowGroup({
  title,
  hint,
  attention = false,
  children,
}: {
  title: string;
  hint?: string;
  attention?: boolean;
  children: ReactNode;
}): ReactElement {
  const id = useId();
  const Heading = useSubheading();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <Heading
        id={id}
        className={cn("px-1 text-title-3", attention ? "text-approval-text" : "text-label-primary")}
      >
        {title}
      </Heading>
      <ul
        className={cn(
          GROUP_ROWS,
          attention && "bg-approval-surface shadow-none ring-1 ring-approval-border",
        )}
      >
        {Children.map(children, (child) => (child === null ? null : <li>{child}</li>))}
      </ul>
      {hint ? <p className="px-1 text-callout text-label-secondary">{hint}</p> : null}
    </section>
  );
}

/** A closed-by-default disclosure for the parts most people never need. */
export function Disclosure({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((o) => !o)}
        className="w-fit text-label-secondary"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--duration-micro) rtl:rotate-180",
            open && "rotate-90 rtl:rotate-90",
          )}
        />
        {label}
      </Button>
      {open ? (
        <div id={`${id}-body`} className="flex flex-col gap-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A detail view's frame: Back above the name, then the status line and the body. It takes the
 * place of the pane's own title while one item is open, so the page never shows two.
 */
export function DetailFrame({
  title,
  status,
  onBack,
  children,
}: {
  title: string;
  /** The line under the name: status and account. */
  status?: ReactNode;
  onBack: () => void;
  children: ReactNode;
}): ReactElement {
  const id = useId();
  const inPage = useContext(InPageContext);
  const Heading = inPage ? "h3" : "h2";
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col items-start gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ms-2">
          <ArrowLeft aria-hidden="true" className="rtl:rotate-180" /> {t("gallery.back")}
        </Button>
        <div className="flex min-w-0 flex-col gap-1">
          <Heading
            id={id}
            className={cn(
              "text-label-primary",
              inPage
                ? "font-display text-[20px] leading-[26px] font-medium"
                : "font-display text-page-title",
            )}
          >
            {title}
          </Heading>
          {status ? <p className="text-callout text-label-secondary">{status}</p> : null}
        </div>
      </header>
      {children}
    </section>
  );
}
