import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { cn } from "../../lib/utils.ts";

/**
 * The unified toolbar (docs/design/redesign-2026.md §4, §5.2): one 52 px row at the top of the
 * content column holding the page or thread title, leading controls (sidebar toggle, back) and
 * trailing controls (pills, bell, ⋯). It is chrome glass (§3.4) that content scrolls under, with a
 * 24 px scroll-edge fade instead of a hard border.
 *
 * Screens don't render a toolbar of their own: they register their content with `useToolbar` and
 * the shell renders one `ToolbarSlot` in the toolbar row. The registry is an external store, so a
 * screen re-rendering updates only the slot, never its own subtree (no render loops).
 */

export const TOOLBAR_HEIGHT = 52;

export interface ToolbarProps extends Omit<React.ComponentProps<"div">, "title"> {
  /**
   * The row is a window drag region (desktop, hidden title bar); buttons, links and fields in it
   * stay clickable.
   */
  drag?: boolean;
  /** Extra leading padding, e.g. to clear the traffic lights when the sidebar is collapsed. */
  inset?: number;
}

/** The 52 px glass row. Usually rendered by `ToolbarSlot`; use it directly for fixed chrome. */
export function Toolbar({ className, drag = false, inset, style, ...props }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      data-slot="toolbar"
      data-drag={drag ? "" : undefined}
      style={inset === undefined ? style : { ...style, paddingInlineStart: inset }}
      className={cn(
        "material-toolbar relative z-10 flex h-[52px] w-full shrink-0 items-center gap-2 px-3 text-label-primary",
        className,
      )}
      {...props}
    />
  );
}

/** Leading controls (sidebar toggle, back). */
export function ToolbarLeading({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar-leading"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

/** Title (text-headline) with an optional one-line subtitle (text-callout). */
export function ToolbarTitle({
  title,
  subtitle,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div
      data-slot="toolbar-title"
      className={cn("flex min-w-0 flex-col justify-center", className)}
      {...props}
    >
      <span className="truncate text-headline text-label-primary">{title}</span>
      {subtitle ? (
        <span className="truncate text-callout text-label-secondary">{subtitle}</span>
      ) : null}
    </div>
  );
}

/** Trailing controls, pushed to the end of the row. */
export function ToolbarTrailing({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toolbar-trailing"
      className={cn("ms-auto flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

/** Adjacent controls on one capsule (macOS 26 groups toolbar buttons onto one piece of glass). */
export function ToolbarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="toolbar-group"
      className={cn("flex items-center gap-0.5 rounded-full bg-fill-tertiary p-0.5", className)}
      {...props}
    />
  );
}

/* ---- Slot API --------------------------------------------------------------------------- */

export interface ToolbarContent {
  /** The page or thread title. */
  title?: ReactNode;
  /** One line under the title (status snippet, counts). */
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}

type Listener = () => void;

/** Registered toolbar contents; the most recently mounted registration is shown. */
export class ToolbarStore {
  #entries = new Map<string, ToolbarContent>();
  #order: string[] = [];
  #listeners = new Set<Listener>();
  #current: ToolbarContent | null = null;

  set(id: string, content: ToolbarContent): void {
    if (!this.#entries.has(id)) this.#order.push(id);
    this.#entries.set(id, content);
    this.#emit();
  }

  remove(id: string): void {
    if (!this.#entries.delete(id)) return;
    this.#order = this.#order.filter((x) => x !== id);
    this.#emit();
  }

  current = (): ToolbarContent | null => this.#current;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit(): void {
    const top = this.#order.at(-1);
    this.#current = top === undefined ? null : (this.#entries.get(top) ?? null);
    for (const l of this.#listeners) l();
  }
}

const ToolbarContext = createContext<ToolbarStore | null>(null);

/** Holds the toolbar registry for a window; the shell wraps the app in it. */
export function ToolbarProvider({
  children,
  store,
}: {
  children?: ReactNode;
  /** A store of your own (tests, stories); one is created otherwise. */
  store?: ToolbarStore;
}): ReactElement {
  const value = useMemo(() => store ?? new ToolbarStore(), [store]);
  return <ToolbarContext.Provider value={value}>{children}</ToolbarContext.Provider>;
}

/**
 * Puts a screen's title and controls in the shell's toolbar while the screen is mounted. Outside
 * a `ToolbarProvider` it does nothing, so screens also render in isolation (stories, tests).
 */
export function useToolbar(content: ToolbarContent): void {
  const store = useContext(ToolbarContext);
  const id = useId();
  // Every render publishes the latest content; only the slot re-renders.
  useLayoutEffect(() => {
    store?.set(id, content);
  });
  useLayoutEffect(() => () => store?.remove(id), [store, id]);
}

/** The current registration, for a shell that lays out the row itself. */
export function useToolbarContent(): ToolbarContent | null {
  const store = useContext(ToolbarContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.current ?? nullContent,
    store?.current ?? nullContent,
  );
}

const noopSubscribe = () => () => {};
const nullContent = () => null;

export interface ToolbarSlotProps extends ToolbarProps {
  /** Shown when no screen has registered (e.g. the window's default title). */
  fallback?: ToolbarContent;
  /** Always-present leading controls (the sidebar toggle), before the screen's own. */
  start?: ReactNode;
}

/** The shell's toolbar row: renders whatever the mounted screen registered with `useToolbar`. */
export function ToolbarSlot({ fallback, start, ...props }: ToolbarSlotProps): ReactElement {
  const content = useToolbarContent() ?? fallback ?? null;
  return (
    <Toolbar {...props}>
      {start || content?.leading ? (
        <ToolbarLeading>
          {start}
          {content?.leading}
        </ToolbarLeading>
      ) : null}
      {content?.title ? <ToolbarTitle title={content.title} subtitle={content.subtitle} /> : null}
      {content?.trailing ? <ToolbarTrailing>{content.trailing}</ToolbarTrailing> : null}
    </Toolbar>
  );
}
