import { House, Library, MessageCircle, UsersRound } from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/**
 * The places (docs/design/consolidation-2026.md §3): the sidebar's destinations and the compact
 * tab bar. Everything else (Scheduled, Notifications, Goals, {persona} & you, Search) is a page
 * reached from Home or ⌘K, which lists every page and action.
 */
export type RailItem = "chat" | "home" | "library" | "people";

/** Every destination is always shown; there is no "More" group any more. */
export type RailGroup = "main";

export const RAIL_ITEMS: readonly {
  id: RailItem;
  label: string;
  route: string;
  icon: typeof MessageCircle;
  group: RailGroup;
  /** The ⌘-digit that opens it, shown beside it in the palette. */
  shortcut?: string;
  /** Extra words the palette matches (not shown). */
  keywords: string;
}[] = [
  {
    id: "chat",
    get label() {
      return t("shell.rail.chat");
    },
    route: "/chat",
    icon: MessageCircle,
    group: "main",
    keywords: "threads conversation messages talk",
    shortcut: "⌘1",
  },
  {
    id: "home",
    get label() {
      return t("home.title");
    },
    route: "/home",
    icon: House,
    group: "main",
    // The pages Home took in, so typing an old name still lands here.
    keywords:
      "dashboard today brief feed news posts digest ideas suggestions goals coming up upcoming needs you inbox approvals nudges keep in touch pinned widgets",
    shortcut: "⌘2",
  },
  {
    id: "library",
    get label() {
      return t("shell.rail.library");
    },
    route: "/library/documents",
    icon: Library,
    group: "main",
    keywords: "documents files images artifacts downloads reports",
    shortcut: "⌘3",
  },
  {
    id: "people",
    get label() {
      return t("people.page.title");
    },
    route: "/people",
    icon: UsersRound,
    group: "main",
    keywords: "contacts projects relationships keep in touch waiting on",
    shortcut: "⌘4",
  },
];

/** Pages off the sidebar, by the place they are reached from (their row stays marked). */
const UNDER_HOME = new Set(["inbox", "feed", "ideas", "goals", "scheduled", "overview"]);

/**
 * The destination a route belongs to (`/library/documents` → library, `/scheduled` → home), or
 * null (Search, Settings). The agent sheet opens over the chat, so `/agent/*` belongs to Chat.
 */
export function destinationFor(route: string): RailItem | null {
  const first = route.split(/[/?#]/)[1] ?? "";
  if (first === "agent") return "chat";
  if (UNDER_HOME.has(first)) return "home";
  return RAIL_ITEMS.find((i) => i.id === first)?.id ?? null;
}

/** The compact tab bar's tabs: every place. */
const TAB_BAR_ITEMS: readonly RailItem[] = ["chat", "home", "library", "people"];

export interface TabBarProps {
  active: RailItem | null;
  onNavigate: (route: string) => void;
  /** Unread / new-candidate counts, spoken with the tab's name. */
  badges?: Partial<Record<RailItem, number>>;
}

/**
 * The compact bottom tab bar (redesign §5.11, under 720 px): Chat, Home, Library and People on
 * chrome glass, 49 px plus the safe area. The current tab is the accent icon and label only, with
 * no tile; Search lives in the top bar's palette.
 */
export function TabBar({ active, onNavigate, badges = {} }: TabBarProps): ReactElement {
  // Search lives in the top bar; the rest of the destinations are in the sidebar and the palette.
  const items = RAIL_ITEMS.filter((i) => TAB_BAR_ITEMS.includes(i.id));
  return (
    <nav
      aria-label={t("shell.rail.main")}
      className="material-glass pb-[env(safe-area-inset-bottom)]"
      data-testid="tab-bar"
    >
      <ul className="flex h-12 items-stretch justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          const badge = badges[item.id] ?? 0;
          const current = active === item.id;
          return (
            <li key={item.id} className="flex flex-1">
              <button
                type="button"
                onClick={() => onNavigate(item.route)}
                aria-current={current ? "page" : undefined}
                aria-label={
                  badge > 0 ? t("shell.rail.badge", { label: item.label, n: badge }) : item.label
                }
                className={cn(
                  "relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  current ? "text-accent-11" : "text-label-secondary",
                )}
              >
                <Icon className="size-5" aria-hidden="true" strokeWidth={1.75} />
                <span className="text-subheadline">{item.label}</span>
                {badge > 0 ? (
                  <span
                    className="absolute top-1.5 start-1/2 ms-2.5 size-2 rounded-full bg-approval"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
