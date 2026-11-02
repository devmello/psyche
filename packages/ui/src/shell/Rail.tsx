import {
  BrainCircuit,
  CalendarClock,
  CircleCheck,
  Inbox,
  Library,
  Lightbulb,
  MessageCircle,
  Newspaper,
  Search,
  UserRound,
} from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/** The destinations, in docs/06 §2.1's order: the sidebar's first group and the compact tab bar. */
export type RailItem =
  | "chat"
  | "inbox"
  | "search"
  | "feed"
  | "ideas"
  | "goals"
  | "scheduled"
  | "library"
  | "memory"
  | "overview";

/**
 * Where a destination sits in the sidebar: `main` rows are always shown, `more` rows live under
 * the "More" group (collapsed until used, never hidden: the palette lists them too).
 */
export type RailGroup = "main" | "more";

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
    id: "inbox",
    get label() {
      return t("shell.rail.inbox");
    },
    route: "/inbox",
    icon: Inbox,
    group: "main",
    keywords: "notifications needs you approvals alerts unread",
    shortcut: "⌘2",
  },
  {
    id: "search",
    get label() {
      return t("shell.rail.search");
    },
    route: "/search",
    icon: Search,
    group: "main",
    keywords: "find lookup everything",
  },
  {
    id: "feed",
    get label() {
      return t("shell.rail.feed");
    },
    route: "/feed",
    icon: Newspaper,
    group: "main",
    keywords: "today brief news posts digest",
    shortcut: "⌘3",
  },
  {
    id: "ideas",
    get label() {
      return t("shell.rail.ideas");
    },
    route: "/ideas",
    icon: Lightbulb,
    group: "more",
    keywords: "suggestions proposed",
  },
  {
    id: "goals",
    get label() {
      return t("shell.rail.goals");
    },
    route: "/goals",
    icon: CircleCheck,
    group: "more",
    keywords: "aims objectives targets",
  },
  {
    id: "scheduled",
    get label() {
      return t("shell.rail.scheduled");
    },
    route: "/scheduled",
    icon: CalendarClock,
    group: "main",
    keywords: "automations runs schedule routines history",
    shortcut: "⌘4",
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
    shortcut: "⌘5",
  },
  {
    id: "memory",
    get label() {
      return t("shell.rail.memory");
    },
    route: "/agent/soul",
    icon: BrainCircuit,
    group: "more",
    keywords: "soul people projects remember review follow-ups",
  },
  {
    id: "overview",
    get label() {
      return t("shell.rail.overview");
    },
    route: "/overview",
    icon: UserRound,
    group: "more",
    keywords:
      "persona and you activity audit log what happened growth recent runs timeline upcoming",
    shortcut: "⌘6",
  },
];

/**
 * The destination a route belongs to (`/library/documents` → library), or null. The agent sheet
 * opens over the chat, so `/agent/*` belongs to Chat.
 */
export function destinationFor(route: string): RailItem | null {
  const first = route.split(/[/?#]/)[1] ?? "";
  if (first === "agent") {
    // The agent sheet opens over whatever is under it; Memory is its own entry,
    // Approvals stay with Chat (Activity and Upcoming moved to the Overview).
    const tab = route.split(/[?#]/)[0]?.split("/")[2];
    if (tab === "soul") return "memory";
    return "chat";
  }
  return RAIL_ITEMS.find((i) => i.id === first)?.id ?? null;
}

/** The compact tab bar's five tabs. */
const TAB_BAR_ITEMS: readonly RailItem[] = ["chat", "inbox", "feed", "library", "overview"];

export interface TabBarProps {
  active: RailItem | null;
  onNavigate: (route: string) => void;
  /** Unread / new-candidate counts, spoken with the tab's name. */
  badges?: Partial<Record<RailItem, number>>;
}

/**
 * The compact bottom tab bar (redesign §5.11, under 720 px): Chat, Feed, Ideas, Goals, Library on
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
                    className="absolute top-1.5 start-1/2 ms-2.5 size-2 rounded-full bg-accent-9"
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
