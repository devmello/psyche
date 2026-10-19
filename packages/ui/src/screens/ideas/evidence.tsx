import { Fragment, type ReactElement } from "react";
import { cn } from "../../lib/utils.ts";

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
  gmail: "Gmail",
  calendar: "Calendar",
  browser: "Browser",
  activity: "Activity",
  chat: "Chat",
  connector: "Connectors",
  memory: "Memory",
  notion: "Notion",
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
      return { route: "/agent/activity", href: null };
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

/** "Because: 3 charges (Gmail); no logins in 90 days (Browser)". */
export function EvidenceLine({ items, onOpenRoute, className }: EvidenceLineProps): ReactElement {
  return (
    <p className={cn("text-sm text-gray-11", className)}>
      <span className="font-medium text-gray-12">Because:</span>{" "}
      {items.length === 0 ? <span>no evidence recorded.</span> : null}
      {items.map((e, i) => {
        const label = e.source ? `${e.text} (${sourceLabel(e.source)})` : e.text;
        let node: ReactElement;
        if (e.route !== null && onOpenRoute) {
          const route = e.route;
          node = (
            <button
              type="button"
              onClick={() => onOpenRoute(route)}
              className="cursor-pointer text-accent-11 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {label}
            </button>
          );
        } else if (e.href !== null) {
          node = (
            <a
              href={e.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent-11 underline underline-offset-2"
            >
              {label}
            </a>
          );
        } else {
          node = <span>{label}</span>;
        }
        return (
          <Fragment key={`${e.ref ?? ""}-${e.text}`}>
            {i > 0 ? "; " : null}
            {node}
          </Fragment>
        );
      })}
    </p>
  );
}
