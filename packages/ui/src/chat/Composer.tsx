import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import { ArrowUp, Mic, Plus, Square, X } from "lucide-react";
import * as m from "motion/react-m";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { motionSpring, spring } from "../motion/index.ts";
import { COMMANDS, type CommandInfo, completion, matchCommands } from "./commands.ts";
import { messageText } from "./MessageView.tsx";

/** Every composer command, as typed (feature C9). */
export const SLASH_COMMANDS: readonly string[] = COMMANDS.map((c) => `/${c.name}`);

/**
 * The `/` autocomplete (feature C9 "commands show in the composer with autocompletion"): open
 * while the composer holds only `/` and a partial name. ↑ / ↓ move, Tab or Return completes the
 * highlighted command (Return sends once the name is complete), Escape closes.
 */
function useCommandMenu() {
  const aui = useAui();
  const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const matches = dismissedFor === text ? [] : matchCommands(text);
  const exact = matches.length === 1 && completion(matches[0] as CommandInfo).trim() === text;
  const open = matches.length > 0 && !exact;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new prefix restarts the highlight
  useEffect(() => setActive(0), [text]);
  const pick = (info: CommandInfo) => {
    aui.composer.setText(completion(info));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    const current = matches[Math.min(active, matches.length - 1)];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + matches.length) % matches.length);
    } else if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && current) {
      e.preventDefault();
      pick(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissedFor(text);
    }
  };
  return { open, matches, active: Math.min(active, matches.length - 1), pick, onKeyDown };
}

export interface ComposerProps {
  persona: string;
  running: boolean;
  disabled?: boolean;
  quoting?: Message | null;
  onClearQuote?: () => void;
  /** How a message sent mid-turn goes; the follow-up strip changes it per queued message. */
  mode?: QueueMode;
  onAttach?: () => void;
  onDictate?: () => void;
  /** Stops the active run (`chat.cancel`). */
  onStop?: () => void;
}

/**
 * Composer (UI design §3.2): attachments, `/` commands, dictation, one Send/Stop pill, the reply
 * quote chip. While the agent works a message waits for the turn to end; the follow-up strip above
 * the composer can send it at once to steer or interrupt (§3.2). Built on assistant-ui's
 * composer primitives; sending goes through the external-store runtime's `onNew`.
 */
export function Composer({
  persona,
  running,
  disabled = false,
  quoting,
  onClearQuote,
  mode = "followUp",
  onAttach,
  onDictate,
  onStop,
}: ComposerProps): ReactElement {
  const menu = useCommandMenu();
  const menuId = useId();
  const hintId = useId();
  const empty = useAuiState((s) => (s.composer.isEditing ? s.composer.text.trim() === "" : true));
  // One Send/Stop button (§5.2): Stop while a run works and the field is empty, Send otherwise
  // (a message sent mid-turn queues); accent fill only when there is text.
  const showStop = running && empty && onStop !== undefined;
  const round =
    "size-7 rounded-full cursor-default [&_svg:not([class*='size-'])]:size-4 disabled:opacity-100";
  return (
    // A floating glass capsule (redesign-2026 §5.2): 44 px at one line, grows with `layout` on
    // spring.smooth up to 40% of the window, then scrolls. At rest no ring; on focus a 1 px ring
    // hairline inside the capsule, no outer glow.
    <m.div
      layout
      transition={motionSpring(spring.smooth)}
      className="material-glass relative rounded-[22px] focus-within:shadow-[inset_0_0_0_1px_var(--ring),var(--material-glass-highlight),var(--elevation-2)]"
      data-testid="composer-capsule"
    >
      <ComposerPrimitive.Root className="flex flex-col">
        {menu.open ? (
          <div
            id={menuId}
            role="listbox"
            aria-label={t("chat.composer.commands")}
            // The slash menu is a level-2 popover: opaque, since glass never sits on glass.
            className="absolute start-0 bottom-full z-10 mb-2 max-h-72 w-full overflow-y-auto rounded-lg bg-surface-overlay p-1 shadow-elevation-2"
          >
            {menu.matches.map((c, i) => (
              <div
                key={c.name}
                id={`${menuId}-${c.name}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === menu.active}
                className={cn(
                  "flex h-7 cursor-default items-baseline gap-2 rounded-sm px-2 py-1 text-body",
                  i === menu.active && "bg-accent-a4",
                )}
                onMouseDown={(e) => {
                  // Keep focus in the composer while picking.
                  e.preventDefault();
                  menu.pick(c);
                }}
              >
                <span className="font-mono text-label-primary">/{c.name}</span>
                {c.hint ? <span className="text-callout text-label-tertiary">{c.hint}</span> : null}
                <span className="ms-auto truncate text-callout text-label-secondary">
                  {c.description}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {quoting ? (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded-md bg-fill-tertiary px-2 py-1 text-callout">
            <span className="text-label-secondary">{t("chat.composer.quoting")}</span>
            <span className="min-w-0 flex-1 truncate text-label-primary">
              {t("chat.quote.text", { text: messageText(quoting) })}
            </span>
            <button
              type="button"
              onClick={onClearQuote}
              aria-label={t("chat.composer.removeQuote")}
              className="inline-flex size-6 cursor-default items-center justify-center rounded-sm text-label-secondary hover:bg-fill-tertiary"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <m.div layout="position" className="flex items-end gap-1 p-1.5">
          {onAttach ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className={round}
              onClick={onAttach}
              aria-label={t("chat.composer.attach")}
              disabled={disabled}
            >
              <Plus aria-hidden="true" />
            </Button>
          ) : null}
          <ComposerPrimitive.Input
            rows={1}
            autoFocus
            disabled={disabled}
            placeholder={
              disabled ? t("chat.composer.offline") : t("chat.composer.placeholder", { persona })
            }
            aria-label={t("chat.composer.label", { persona })}
            data-composer-input=""
            onKeyDown={menu.onKeyDown}
            aria-autocomplete="list"
            aria-describedby={hintId}
            {...(menu.open
              ? {
                  "aria-controls": menuId,
                  "aria-activedescendant": `${menuId}-${menu.matches[menu.active]?.name ?? ""}`,
                }
              : {})}
            className="max-h-[40vh] min-h-8 min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-reading text-label-primary outline-none placeholder:text-label-tertiary disabled:cursor-not-allowed"
          />
          <span id={hintId} className="sr-only">
            {!running
              ? t("chat.composer.hintIdle")
              : mode === "followUp"
                ? t("chat.composer.hintFollowUp", { persona })
                : mode === "steer"
                  ? t("chat.composer.hintSteer", { persona })
                  : t("chat.composer.hintInterrupt", { persona })}
          </span>
          {onDictate ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className={round}
              onClick={onDictate}
              aria-label={t("chat.composer.dictate")}
              disabled={disabled}
            >
              <Mic aria-hidden="true" />
            </Button>
          ) : null}
          {showStop ? (
            <Button
              size="icon-sm"
              variant="secondary"
              className={round}
              aria-label={t("chat.composer.stop")}
              onClick={onStop}
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <ComposerPrimitive.Send
              render={
                <Button
                  size="icon-sm"
                  variant={empty ? "secondary" : "default"}
                  className={cn(round, empty && "text-label-tertiary")}
                  aria-label={t("chat.composer.send")}
                  disabled={disabled || empty}
                />
              }
            >
              <ArrowUp aria-hidden="true" />
            </ComposerPrimitive.Send>
          )}
        </m.div>
      </ComposerPrimitive.Root>
    </m.div>
  );
}
