import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { SearchHit } from "@psyche/protocol";
import { type ReactElement, useEffect } from "react";
import { useThreads } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { ConnectedEntityCard } from "../people/ConnectedEntityCard.tsx";
import { SearchSurface, useMinWidth, useSearchSurface } from "../screens/search/SearchSurface.tsx";
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
    id: "approvals",
    get label() {
      return t("shell.palette.approvals");
    },
    route: "/agent/approvals",
    shortcut: "⌘⇧P",
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

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (route: string) => void;
  /** Slash commands and pane actions the shell adds (`/model`, open Browser pane …). */
  actions?: readonly PaletteAction[];
  /** ⌘↵ on a result; defaults to a new side chat named after it. */
  onOpenInSideChat?: (hit: SearchHit) => void;
  /** Leave out the built-in Go to / Settings actions (the host lists its own). */
  builtInActions?: boolean;
  /** What the field holds when the palette opens. */
  initialQuery?: string;
}

/** The shortcut shown beside an action: its own, else the keyboard map's. */
function withShortcut(a: PaletteAction): PaletteAction {
  const keys = a.shortcut ?? SHORTCUTS.find((s) => s.id === a.id)?.keys;
  return keys === undefined ? a : { ...a, shortcut: keys };
}

/**
 * ⌘K (redesign §5.5, UI design §2.5): the search surface in a level-2 glass palette, 640 px wide,
 * centred 20% from the top, with the actions as a last group and a preview when the window is at
 * least 1080 px wide. It enters like a popover (scale 0.97 + fade) and leaves by fading.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  actions = [],
  onOpenInSideChat,
  builtInActions = true,
  initialQuery = "",
}: CommandPaletteProps): ReactElement {
  const search = useSearchSurface(initialQuery, 150, open);
  const wide = useMinWidth(1080);
  const threads = useThreads();
  const { setQuery } = search;
  // A fresh palette every time it opens.
  useEffect(() => {
    if (!open) setQuery(initialQuery);
  }, [open, setQuery, initialQuery]);
  const close = () => onOpenChange(false);
  // The host's actions first; a built-in one with the same id gives way to the host's.
  const builtIn = builtInActions
    ? DEFAULT_ACTIONS.filter((d) => !actions.some((a) => a.id === d.id))
    : [];
  const all = [...actions, ...builtIn].map(withShortcut);
  const sideChat =
    onOpenInSideChat ??
    ((hit: SearchHit) => {
      void threads
        .create({ kind: "side", title: hit.title.slice(0, 200) })
        .then((thread) => onNavigate(`/chat/${thread.id}`));
    });
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="dialog-overlay"
          className="psy-backdrop fixed inset-0 z-50 bg-black/10"
        />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          data-testid="palette"
          className="psy-popup fixed top-[20%] left-1/2 z-50 flex w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl material-glass text-label-primary outline-none"
          style={{ ["--transform-origin" as string]: "top center" }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("shell.palette.title")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t("shell.palette.description")}
          </DialogPrimitive.Description>
          <SearchSurface
            variant="palette"
            query={search.query}
            onQueryChange={search.setQuery}
            hits={search.hits}
            parsed={search.parsed}
            loading={search.loading}
            loadingDelayMs={150}
            error={search.error}
            onRetry={search.reload}
            actions={all}
            preview={wide}
            autoFocus
            onOpen={(hit) => {
              close();
              if (hit.route != null) onNavigate(hit.route);
            }}
            onOpenInSideChat={(hit) => {
              close();
              sideChat(hit);
            }}
            onRunAction={(a) => {
              close();
              if (a.run) a.run();
              else if (a.route) onNavigate(a.route);
            }}
            entities={search.entities}
            onOpenEntity={(e) => {
              close();
              onNavigate(`/agent/soul?entity=${encodeURIComponent(e.id)}`);
            }}
            renderEntityPreview={(e) => (
              <ConnectedEntityCard
                id={e.id}
                recentLimit={3}
                className="bg-transparent p-0 shadow-none"
                onOpenEntity={(id) => {
                  close();
                  onNavigate(`/agent/soul?entity=${encodeURIComponent(id)}`);
                }}
              />
            )}
          />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
