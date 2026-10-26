import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { SafeLink } from "../../links/SafeLink.tsx";

/**
 * "Because:" evidence for ideas and inferred goals (UI design §3.10, §3.11). Evidence is untyped
 * JSON in the protocol; the kit reads `{ source, text, ref, route? }` (fixture convention) and
 * links each item to its source when the ref maps to an in-app route or a web page.
 */

export interface EvidenceItem {
  source: string | null;
  text: string;
  ref: string | null;
  /** In-app route, opened with `navigate`. */
  route: string | null;
  /** Web page, opened in a new window. */
  href: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  get gmail() {
    return t("screens.evidence.source.gmail");
  },
  get calendar() {
    return t("screens.evidence.source.calendar");
  },
  get browser() {
    return t("screens.evidence.source.browser");
  },
  get activity() {
    return t("screens.evidence.source.activity");
  },
  get chat() {
    return t("screens.evidence.source.chat");
  },
  get connector() {
    return t("screens.evidence.source.connector");
  },
  get memory() {
    return t("screens.evidence.source.memory");
  },
  get notion() {
    return t("screens.evidence.source.notion");
  },
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** Maps an evidence ref to an in-app route or a web link. */
export function evidenceTarget(ref: string | null): { route: string | null; href: string | null } {
  if (ref === null || ref === "") return { route: null, href: null };
  if (/^https?:\/\//i.test(ref)) return { route: null, href: ref };
  if (ref.startsWith("/")) return { route: ref, href: null };
  const sep = ref.indexOf(":");
  const kind = sep < 0 ? ref : ref.slice(0, sep);
  const id = sep < 0 ? "" : ref.slice(sep + 1);
  switch (kind) {
    case "thread":
      return { route: `/chat/${id}`, href: null };
    case "task":
      return { route: `/agent/activity/${id}`, href: null };
    case "tasks":
      return { route: "/overview#now", href: null };
    case "goal":
      return { route: `/goals/${id}`, href: null };
    case "connector":
      return { route: "/settings/connectors", href: null };
    case "memory":
      return { route: `/agent/soul?file=${encodeURIComponent(id)}`, href: null };
    case "library":
      return { route: "/library/documents", href: null };
    default:
      return { route: null, href: null };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function readEvidence(list: unknown): EvidenceItem[] {
  if (!Array.isArray(list)) return [];
  const out: EvidenceItem[] = [];
  for (const raw of list) {
    if (typeof raw === "string") {
      out.push({ source: null, text: raw, ref: null, route: null, href: null });
      continue;
    }
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const text = str(o.text) ?? str(o.summary) ?? str(o.title);
    if (text === null) continue;
    const ref = str(o.ref);
    const target = evidenceTarget(ref);
    out.push({
      source: str(o.source),
      text,
      ref,
      route: str(o.route) ?? target.route,
      href: str(o.url) ?? target.href,
    });
  }
  return out;
}

export interface EvidenceLineProps {
  items: readonly EvidenceItem[];
  onOpenRoute?: (route: string) => void;
  className?: string;
}

const linkClass =
  "cursor-pointer text-start text-label-primary underline decoration-separator-strong underline-offset-2 hover:decoration-accent-9 focus-visible:outline-2 focus-visible:outline-ring";

/**
 * "Because:" then one line per item, each linked to its source with the source named after it
 * ("3 charges · Gmail"). One item per line keeps long evidence from wrapping into a ragged run.
 */
export function EvidenceLine({ items, onOpenRoute, className }: EvidenceLineProps): ReactElement {
  return (
    <div className={cn("flex flex-col gap-1 text-callout text-label-secondary", className)}>
      <p className="font-medium text-label-primary">
        {t("screens.evidence.because")}
        {items.length === 0 ? (
          <span className="font-normal"> {t("screens.evidence.none")}</span>
        ) : null}
      </p>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {items.map((e) => {
            let node: ReactElement;
            if (e.route !== null && onOpenRoute) {
              const route = e.route;
              node = (
                <button type="button" onClick={() => onOpenRoute(route)} className={linkClass}>
                  {e.text}
                </button>
              );
            } else if (e.href !== null) {
              node = (
                <SafeLink href={e.href} className={linkClass}>
                  {e.text}
                </SafeLink>
              );
            } else {
              node = <span className="text-label-primary">{e.text}</span>;
            }
            return (
              <li key={`${e.ref ?? ""}-${e.text}`} className="flex min-w-0 items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className="size-1 shrink-0 translate-y-[-2px] rounded-full bg-label-quaternary"
                />
                <span className="min-w-0">
                  {node}
                  {e.source ? (
                    <span className="text-callout text-label-secondary">
                      {" "}
                      · {sourceLabel(e.source)}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
