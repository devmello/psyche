import type { SearchHit, SearchScope } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../components/ui/command.tsx";
import { useSearch, useThreads } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { SCOPE_LABEL } from "../screens/search/search-query.ts";
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
  ...RAIL_ITEMS.map((i) => ({
    id: `go-${i.id}`,
    get label() {
      return t("shell.palette.goTo", { label: i.label });
    },
    route: i.route,
  })),
  {
    id: "activity",
    get label() {
      return t("shell.palette.activity");
    },
    route: "/agent/activity",
    shortcut: "⌘⇧A",
  },
  {
    id: "approvals",
    get label() {
      return t("shell.palette.approvals");
    },
    route: "/agent/approvals",
    shortcut: "⌘⇧P",
  },
  {
    id: "upcoming",
    get label() {
      return t("shell.palette.upcoming");
    },
    route: "/agent/upcoming",
  },
  {
    id: "soul",
    get label() {
      return t("shell.palette.soul");
    },
    route: "/agent/soul",
  },
  {
    id: "inbox",
    get label() {
      return t("shell.palette.inbox");
    },
    route: "/inbox",
  },
  {
    id: "settings",
    get label() {
      return t("shell.palette.settings");
    },
    route: "/settings/model",
  },
  {
    id: "appearance",
    get label() {
      return t("shell.palette.appearance");
    },
    route: "/settings/appearance",
  },
  {
    id: "permissions",
    get label() {
      return t("shell.palette.permissions");
    },
    route: "/settings/permissions",
  },
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
      title={t("shell.palette.title")}
      description={t("shell.palette.description")}
    >
      <Command shouldFilter={search.hits.length === 0}>
        <CommandInput
          placeholder={t("shell.palette.placeholder")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {search.loading ? t("shell.palette.searching") : t("shell.palette.nothing")}
          </CommandEmpty>
          {[...search.groups.entries()].map(([scope, hits]) => (
            <CommandGroup
              key={scope}
              heading={t("shell.palette.group", {
                scope: SCOPE_LABEL[scope as SearchScope] ?? scope,
                n: hits.length,
              })}
            >
              {hits.map((h: SearchHit) => (
                <CommandItem
                  key={`${scope}:${h.id}`}
                  value={`${scope} ${h.title} ${h.snippet}`}
                  onSelect={() => h.route && go(h.route)}
                >
                  <span className="truncate">{h.title}</span>
                  <span className="ms-2 truncate text-xs text-muted-foreground">{h.snippet}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          <CommandGroup heading={t("shell.palette.threads")}>
            {threads.all.slice(0, 6).map((entry) => (
              <CommandItem
                key={entry.thread.id}
                value={`thread ${entry.thread.title}`}
                onSelect={() => go(`/chat/${entry.thread.id}`)}
              >
                {entry.thread.title}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading={t("shell.palette.actions")}>
            {[...actions, ...DEFAULT_ACTIONS].map((a) => (
              <CommandItem key={a.id} value={a.label} onSelect={() => run(a)}>
                {a.label}
                {shortcutFor(a) ? <CommandShortcut>{shortcutFor(a)}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
