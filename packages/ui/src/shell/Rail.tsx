import {
  CircleCheck,
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
export type RailItem = "chat" | "search" | "feed" | "ideas" | "goals" | "library" | "overview";

export const RAIL_ITEMS: readonly {
  id: RailItem;
  label: string;
  route: string;
  icon: typeof MessageCircle;
}[] = [
  {
    id: "chat",
    get label() {
      return t("shell.rail.chat");
    },
    route: "/chat",
    icon: MessageCircle,
  },
  {
    id: "search",
    get label() {
      return t("shell.rail.search");
    },
    route: "/search",
    icon: Search,
  },
  {
    id: "feed",
    get label() {
      return t("shell.rail.feed");
    },
    route: "/feed",
    icon: Newspaper,
  },
  {
    id: "ideas",
    get label() {
      return t("shell.rail.ideas");
    },
    route: "/ideas",
    icon: Lightbulb,
  },
  {
    id: "goals",
    get label() {
      return t("shell.rail.goals");
    },
    route: "/goals",
    icon: CircleCheck,
  },
  {
    id: "library",
    get label() {
      return t("shell.rail.library");
    },
    route: "/library/documents",
    icon: Library,
  },
  {
    id: "overview",
    get label() {
      return t("shell.rail.overview");
    },
    route: "/overview",
    icon: UserRound,
  },
];

/**
 * The destination a route belongs to (`/library/documents` → library), or null. The agent sheet
 * opens over the chat, so `/agent/*` belongs to Chat.
 */
export function destinationFor(route: string): RailItem | null {
  const first = route.split(/[/?#]/)[1] ?? "";
  if (first === "agent") return "chat";
  return RAIL_ITEMS.find((i) => i.id === first)?.id ?? null;
}

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
  const items = RAIL_ITEMS.filter((i) => i.id !== "search");
  return (
    <nav
      aria-label={t("shell.rail.main")}
      className="material-glass pb-[env(safe-area-inset-bottom)]"
      data-testid="tab-bar"
    >
      <ul className="flex h-[49px] items-stretch justify-around">
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
