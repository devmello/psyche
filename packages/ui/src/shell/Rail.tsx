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
import { cn } from "../lib/utils.ts";

export type RailItem = "chat" | "search" | "feed" | "ideas" | "goals" | "library";

export const RAIL_ITEMS: readonly {
  id: RailItem;
  label: string;
  route: string;
  icon: typeof MessageCircle;
}[] = [
  { id: "chat", label: "Chat", route: "/chat", icon: MessageCircle },
  { id: "search", label: "Search", route: "/search", icon: Search },
  { id: "feed", label: "Feed", route: "/feed", icon: Newspaper },
  { id: "ideas", label: "Ideas", route: "/ideas", icon: Lightbulb },
  { id: "goals", label: "Goals", route: "/goals", icon: CircleCheck },
  { id: "library", label: "Library", route: "/library/documents", icon: Library },
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
              aria-label={badge > 0 ? `${item.label}, ${badge} new` : item.label}
              className={cn(
                "relative flex flex-col items-center gap-0.5 rounded-lg p-2 text-gray-11 hover:bg-gray-3 hover:text-foreground",
                active === item.id && "bg-accent-3 text-accent-11",
              )}
            >
              <Icon className="size-5" aria-hidden="true" strokeWidth={1.75} />
              <span className="text-[10px] leading-3">{item.label}</span>
              {badge > 0 ? (
                <span
                  className="absolute top-1 right-1 size-2 rounded-full bg-accent-9"
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
      <nav aria-label="Main" className="border-t border-gray-6 bg-background px-2 py-1">
        {list}
      </nav>
    );
  }
  return (
    <nav
      aria-label="Main"
      className="flex h-full w-[var(--rail-width)] flex-col items-center border-r border-gray-6 bg-gray-1 py-3"
    >
      {list}
      <div className="mt-auto">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Menu" />}>
            <Menu aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end">
            <DropdownMenuItem onClick={() => onNavigate("/settings/model")}>
              <Settings aria-hidden="true" /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onNavigate("/settings/usage")}>Usage</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onNavigate("/settings/about")}>Help</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
