import {
  CircleCheck,
  Library,
  Lightbulb,
  Menu,
  MessageCircle,
  Newspaper,
  Search,
  Settings,
} from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

export type RailItem = "chat" | "search" | "feed" | "ideas" | "goals" | "library";

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
];

export interface RailProps {
  active: RailItem | null;
  onNavigate: (route: string) => void;
  /** Unread / new-candidate badges (Feed, Ideas). */
  badges?: Partial<Record<RailItem, number>>;
  /** Compact (< 720 px): a bottom tab bar with Chat, Feed, Ideas, Goals, Library (§3.24). */
  compact?: boolean;
}

/** Left rail (UI design §2.1): 56 px, with the bottom menu (Settings, Usage, Help). */
export function Rail({
  active,
  onNavigate,
  badges = {},
  compact = false,
}: RailProps): ReactElement {
  const items = compact ? RAIL_ITEMS.filter((i) => i.id !== "search") : RAIL_ITEMS;
  const list = (
    <ul className={cn("flex", compact ? "w-full justify-around" : "flex-col items-center gap-1")}>
      {items.map((item) => {
        const Icon = item.icon;
        const badge = badges[item.id] ?? 0;
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onNavigate(item.route)}
              aria-current={active === item.id ? "page" : undefined}
              aria-label={
                badge > 0 ? t("shell.rail.badge", { label: item.label, n: badge }) : item.label
              }
              className={cn(
                "relative flex flex-col items-center gap-0.5 rounded-lg p-2 text-gray-11 hover:bg-gray-3 hover:text-foreground",
                active === item.id && "bg-accent-3 text-accent-11",
              )}
            >
              <Icon className="size-5" aria-hidden="true" strokeWidth={1.75} />
              <span className="text-[10px] leading-3">{item.label}</span>
              {badge > 0 ? (
                <span
                  className="absolute top-1 end-1 size-2 rounded-full bg-accent-9"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
  if (compact) {
    return (
      <nav
        aria-label={t("shell.rail.main")}
        className="border-t border-gray-6 bg-background px-2 py-1"
      >
        {list}
      </nav>
    );
  }
  return (
    <nav
      aria-label={t("shell.rail.main")}
      className="flex h-full w-[var(--rail-width)] flex-col items-center border-e border-gray-6 bg-gray-1 py-3"
    >
      {list}
      <div className="mt-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" aria-label={t("shell.rail.menu")} />}
          >
            <Menu aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="inline-end" align="end">
            <DropdownMenuItem onClick={() => onNavigate("/settings/model")}>
              <Settings aria-hidden="true" /> {t("shell.rail.settings")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onNavigate("/settings/usage")}>
              {t("shell.rail.usage")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onNavigate("/settings/about")}>
              {t("shell.rail.help")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
