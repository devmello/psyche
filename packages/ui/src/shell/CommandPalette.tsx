import type { SearchHit } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../components/ui/command.tsx";
import { useSearch, useThreads } from "../data/index.ts";
import { RAIL_ITEMS } from "./Rail.tsx";
import { SHORTCUTS } from "./shortcuts.ts";

export interface PaletteAction {
  id: string;
  label: string;
  route?: string;
  shortcut?: string;
  run?: () => void;
}

/** Built-in actions (UI design §2.5): open a screen or pane, `/model`, `/schedule`, settings. */
export const DEFAULT_ACTIONS: readonly PaletteAction[] = [
  ...RAIL_ITEMS.map((i) => ({ id: `go-${i.id}`, label: `Go to ${i.label}`, route: i.route })),
  { id: "activity", label: "Open Activity", route: "/agent/activity", shortcut: "⌘⇧A" },
  { id: "approvals", label: "Open Approvals", route: "/agent/approvals", shortcut: "⌘⇧P" },
  { id: "upcoming", label: "Open Upcoming", route: "/agent/upcoming" },
  { id: "soul", label: "Open Soul & Memory", route: "/agent/soul" },
  { id: "inbox", label: "Open notifications", route: "/inbox" },
  { id: "settings", label: "Settings", route: "/settings/model" },
  { id: "appearance", label: "Settings → Appearance", route: "/settings/appearance" },
  { id: "permissions", label: "Settings → Permissions", route: "/settings/permissions" },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (route: string) => void;
  /** Slash commands and pane actions the shell adds (`/model`, `/schedule`, open Browser pane …). */
  actions?: readonly PaletteAction[];
}

/** ⌘K: searches the unified index and lists actions (UI design §2.5, §3.13). */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  actions = [],
}: CommandPaletteProps): ReactElement {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 150);
  const search = useSearch(open ? debounced : "");
  const threads = useThreads();
  const go = (route: string) => {
    onOpenChange(false);
    onNavigate(route);
  };
  const run = (a: PaletteAction) => {
    onOpenChange(false);
    if (a.run) a.run();
    else if (a.route) onNavigate(a.route);
  };
  const shortcutFor = (a: PaletteAction) =>
    a.shortcut ?? SHORTCUTS.find((s) => s.id === a.id)?.keys;
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search Psyche or run a command"
    >
      <CommandInput placeholder="Search or type a command" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{search.loading ? "Searching…" : "Nothing found."}</CommandEmpty>
        {[...search.groups.entries()].map(([scope, hits]) => (
          <CommandGroup key={scope} heading={`${scope} (${hits.length})`}>
            {hits.map((h: SearchHit) => (
              <CommandItem
                key={`${scope}:${h.id}`}
                value={`${scope} ${h.title} ${h.snippet}`}
                onSelect={() => h.route && go(h.route)}
              >
                <span className="truncate">{h.title}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{h.snippet}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandGroup heading="Threads">
          {threads.all.slice(0, 6).map((t) => (
            <CommandItem
              key={t.thread.id}
              value={`thread ${t.thread.title}`}
              onSelect={() => go(`/chat/${t.thread.id}`)}
            >
              {t.thread.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          {[...actions, ...DEFAULT_ACTIONS].map((a) => (
            <CommandItem key={a.id} value={a.label} onSelect={() => run(a)}>
              {a.label}
              {shortcutFor(a) ? <CommandShortcut>{shortcutFor(a)}</CommandShortcut> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
