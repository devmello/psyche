import { useAui, useAuiState } from "@assistant-ui/react";
import { Check } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useMemo, useState } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import {
  type ArgContext,
  type ArgOption,
  argQuery,
  filterOptions,
  isComplete,
} from "./command-args.ts";
import { COMMANDS } from "./commands.ts";

/** Before `models.list` has loaded: sources that need the context list nothing. */
const NO_CONTEXT: ArgContext = { models: undefined, modelRef: null, permissionMode: undefined };

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === "function";
}

/**
 * The argument popup: after `/name ` of a command that declares `args: { kind: "enum" }`, the
 * valid values above the composer. Same keys as the `/` menu: ↑ / ↓ move (skipping values that
 * cannot be used), Return or Tab picks the highlighted value and runs the command as if it had
 * been typed in full, Escape closes. Typing filters; a value typed in full closes the popup so
 * Return sends it.
 */
export function useArgMenu(ctx: ArgContext = NO_CONTEXT) {
  const aui = useAui();
  const menuId = useId();
  const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const parsed = argQuery(text);
  const spec = parsed === null ? undefined : COMMANDS.find((c) => c.name === parsed.name)?.args;
  const name = parsed?.name ?? "";
  const query = parsed?.query ?? "";

  // The source runs when the popup first needs it and again only when its data changes; an
  // async source is awaited (and caches itself, see `memoizeOptions`).
  const source = useMemo(() => (spec === undefined ? undefined : spec.options(ctx)), [spec, ctx]);
  const [loaded, setLoaded] = useState<{
    source: PromiseLike<readonly ArgOption[]>;
    options: readonly ArgOption[];
  } | null>(null);
  useEffect(() => {
    if (source === undefined || !isThenable(source)) return;
    let live = true;
    source.then(
      (options) => live && setLoaded({ source, options }),
      () => live && setLoaded({ source, options: [] }),
    );
    return () => {
      live = false;
    };
  }, [source]);
  const options: readonly ArgOption[] | null =
    source === undefined
      ? null
      : isThenable(source)
        ? loaded?.source === source
          ? loaded.options
          : null
        : source;

  const loading = spec !== undefined && options === null;
  const matches = useMemo(
    () => (options === null ? [] : filterOptions(options, query)),
    [options, query],
  );
  const complete = options !== null && isComplete(options, query);
  const open =
    spec !== undefined && dismissedFor !== text && !complete && (loading || matches.length > 0);
  const current = spec?.current?.(ctx) ?? null;

  const enabled = (i: number) => matches[i]?.disabledReason === undefined;
  const firstEnabled = matches.findIndex((o) => o.disabledReason === undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query restarts the highlight
  useEffect(() => setActive(0), [text]);
  const activeIndex = enabled(active) ? Math.min(active, matches.length - 1) : firstEnabled;

  const pick = (option: ArgOption) => {
    if (option.disabledReason !== undefined) return;
    aui.composer.setText(`/${name} ${option.value}`);
    aui.composer.send();
  };
  const move = (step: 1 | -1) => {
    if (firstEnabled < 0) return;
    let i = activeIndex;
    do i = (i + step + matches.length) % matches.length;
    while (!enabled(i));
    setActive(i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    const option = matches[activeIndex];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && option) {
      e.preventDefault();
      pick(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissedFor(text);
    }
  };
  return {
    open,
    id: menuId,
    command: name,
    loading,
    matches,
    current,
    active: activeIndex,
    optionId: (i: number) => `${menuId}-${i}`,
    pick,
    onKeyDown,
  };
}

export type ArgMenuState = ReturnType<typeof useArgMenu>;

/** The popup itself: a listbox that looks like the `/` menu's. */
export function ArgMenu({ menu }: { menu: ArgMenuState }): ReactElement {
  return (
    <div
      className="absolute start-0 bottom-full z-10 mb-2 max-h-72 w-full overflow-y-auto rounded-lg bg-surface-overlay p-1 shadow-elevation-2"
      data-testid="arg-menu"
    >
      {menu.loading ? (
        <div role="status" className="px-2 py-1 text-callout text-label-secondary">
          {t("chat.args.loading")}
        </div>
      ) : (
        <>
          <div
            id={menu.id}
            role="listbox"
            aria-label={t("chat.args.label", { command: menu.command })}
          >
            {menu.matches.map((o, i) => {
              const disabled = o.disabledReason !== undefined;
              const isCurrent = o.value === menu.current;
              return (
                <div
                  key={o.value}
                  id={menu.optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === menu.active}
                  aria-disabled={disabled || undefined}
                  className={cn(
                    "flex h-7 cursor-default items-baseline gap-2 rounded-sm px-2 py-1 text-body",
                    i === menu.active && "bg-accent-a4",
                    disabled && "text-label-tertiary",
                  )}
                  onMouseDown={(e) => {
                    // Keep focus in the composer while picking.
                    e.preventDefault();
                    menu.pick(o);
                  }}
                >
                  <span className={cn("font-mono", !disabled && "text-label-primary")}>
                    {o.label ?? o.value}
                  </span>
                  {o.badges?.map((b) => (
                    <span
                      key={b}
                      className="shrink-0 rounded-xs bg-fill-tertiary px-1 text-caption text-label-secondary"
                    >
                      {b}
                    </span>
                  ))}
                  {isCurrent ? (
                    <>
                      <Check
                        className="size-3.5 shrink-0 self-center text-accent-9"
                        aria-hidden="true"
                      />
                      <span className="sr-only">{t("chat.args.current")}</span>
                    </>
                  ) : null}
                  <span className="ms-auto truncate text-callout text-label-secondary">
                    {o.disabledReason ?? o.detail}
                  </span>
                </div>
              );
            })}
          </div>
          <div role="status" className="sr-only">
            {t("chat.args.count", { count: menu.matches.length })}
          </div>
        </>
      )}
    </div>
  );
}
