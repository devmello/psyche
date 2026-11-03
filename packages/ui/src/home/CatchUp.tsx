import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { activeI18n, t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/**
 * One thing to catch up on: a project, an assignment, work that is due or mail that wants an
 * answer, with what changed in a sentence ("You finished the outline yesterday."). A UI type
 * for now; the memory-for-everything work decides where the data comes from.
 */
export interface CatchUpItem {
  id: string;
  kind: "project" | "assignment" | "mail" | "task";
  title: string;
  /** What changed, or what is next, in one sentence. */
  line: string;
  /** When it is due (ISO); absent for things with no date. */
  dueAt?: string;
  /** Where it came from ("Canvas", "Gmail"). */
  source?: string;
  /** The page the row opens, if it has one. */
  route?: string;
}

const DAY = 86_400_000;

/**
 * "Catching up": the first part of Today's brief (docs/design/home-2026.md §5). Short rows, the
 * soonest due first; a due date is plain text in the row's end, with the weight of ink and never
 * amber, because amber is for what needs the owner. Nothing is drawn without items.
 */
export function CatchUp({
  items,
  now,
  onOpen,
  limit = 3,
}: {
  items: readonly CatchUpItem[];
  now: number;
  onOpen?: (route: string) => void;
  limit?: number;
}): ReactElement | null {
  // Dated rows first, soonest first; then the undated ones in the order given.
  const dueMs = (i: CatchUpItem) => (i.dueAt === undefined ? Number.NaN : Date.parse(i.dueAt));
  const dated = items.filter((i) => !Number.isNaN(dueMs(i))).sort((a, b) => dueMs(a) - dueMs(b));
  const rows = [...dated, ...items.filter((i) => Number.isNaN(dueMs(i)))].slice(0, limit);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="catch-up-heading" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 px-1">
        <h3 id="catch-up-heading" className="text-body font-medium text-label-primary">
          {t("home.catchUp")}
        </h3>
        <p className="min-w-0 truncate text-callout text-label-secondary">
          {t("home.catchUp.hint")}
        </p>
      </div>
      <ul
        aria-labelledby="catch-up-heading"
        className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
        data-testid="catch-up"
      >
        {rows.map((item) => {
          const soon = item.dueAt !== undefined && Date.parse(item.dueAt) - now < 2 * DAY;
          const body = (
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body text-label-primary">{item.title}</span>
                <span className="text-callout text-label-secondary">
                  {item.line}
                  {item.source ? ` · ${item.source}` : ""}
                </span>
              </span>
              {item.dueAt ? (
                <span
                  className={cn(
                    "shrink-0 text-callout tabular-nums",
                    soon ? "font-medium text-label-primary" : "text-label-secondary",
                  )}
                >
                  {t("home.catchUp.due", {
                    when: activeI18n().date(Date.parse(item.dueAt), {
                      weekday: "short",
                      ...(Date.parse(item.dueAt) - now > 6 * DAY
                        ? { month: "short", day: "numeric" }
                        : {}),
                    }),
                  })}
                </span>
              ) : null}
            </>
          );
          const route = item.route;
          return (
            <li
              key={item.id}
              className="relative before:absolute before:inset-x-2.5 before:top-0 before:h-px before:bg-separator first:before:hidden"
            >
              {route !== undefined && onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(route)}
                  aria-label={t("home.catchUp.open", { title: item.title })}
                  className="flex min-h-11 w-full items-center gap-3 rounded-sm px-2.5 py-1.5 text-start outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {body}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-label-tertiary rtl:-scale-x-100"
                  />
                </button>
              ) : (
                <div className="flex min-h-11 items-center gap-3 px-2.5 py-1.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
