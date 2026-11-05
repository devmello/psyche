import { Brain, House, Library, MessageCircle } from "lucide-react";
import type { ReactElement } from "react";
import { legacyRedirect } from "../home/redirects.ts";
import { t } from "../i18n/core.ts";
import { keysLabel } from "../lib/keys.ts";
import { cn } from "../lib/utils.ts";

/**
 * The places (docs/design/consolidation-2026.md §3): the sidebar's destinations and the compact
 * tab bar. Everything else (Scheduled, Notifications, Goals, {persona} & you, Search) is a page
 * reached from Home or ⌘K, which lists every page and action.
 */
export type RailItem = "chat" | "home" | "library" | "memory";

/** Every destination is always shown; there is no "More" group any more. */
export type RailGroup = "main";

export const RAIL_ITEMS: readonly {
  id: RailItem;
  label: string;
  route: string;
  icon: typeof MessageCircle;
  group: RailGroup;
  /** The digit whose ⌘-digit (Ctrl+digit on Windows) opens it. */
  digit?: number;
  /** That shortcut as shown beside it in the palette ("⌘1", "Ctrl+1"). */
  readonly shortcut?: string;
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
    digit: 1,
    get shortcut() {
      return keysLabel("Mod+1");
    },
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
    digit: 2,
    get shortcut() {
      return keysLabel("Mod+2");
    },
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
    digit: 3,
    get shortcut() {
      return keysLabel("Mod+3");
    },
  },
  {
    id: "memory",
    get label() {
      return t("memory.page.title");
    },
    route: "/memory",
    icon: Brain,
    group: "main",
    // People was this row before Memory took it in (docs/design/memory-everything-2026.md §6).
    keywords:
      "people contacts projects courses work due to-do deadlines bills events relationships keep in touch waiting on remember review",
    digit: 4,
    get shortcut() {
      return keysLabel("Mod+4");
    },
  },
];

/** Pages off the sidebar, by the place they are reached from (their row stays marked). */
const UNDER_HOME = new Set(["inbox", "feed", "ideas", "goals", "scheduled", "overview"]);

/**
 * The destination a route belongs to (`/library/documents` → library, `/scheduled` → home), or
 * null (Search, Settings). The agent sheet opens over the chat, so `/agent/*` belongs to Chat.
 */
export function destinationFor(route: string): RailItem | null {
  // An old route belongs to the place it moved to (`/people` → Memory, `/agent/soul?entity=`).
  const moved = legacyRedirect(route);
  if (moved !== null) return destinationFor(moved);
  const first = route.split(/[/?#]/)[1] ?? "";
  if (first === "agent") return "chat";
  if (UNDER_HOME.has(first)) return "home";
  return RAIL_ITEMS.find((i) => i.id === first)?.id ?? null;
}

/** The compact tab bar's tabs: every place. */
const TAB_BAR_ITEMS: readonly RailItem[] = ["chat", "home", "library", "memory"];

export interface TabBarProps {
  active: RailItem | null;
  onNavigate: (route: string) => void;
  /** Unread / new-candidate counts, spoken with the tab's name. */
  badges?: Partial<Record<RailItem, number>>;
}

/**
 * The compact bottom tab bar (redesign §5.11, under 720 px): Chat, Home, Library and Memory on
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
