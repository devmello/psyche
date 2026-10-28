import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import {
  AlertCircle,
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Newspaper,
  Plus,
  Square,
  X,
} from "lucide-react";
import * as m from "motion/react-m";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { GlassSurface } from "../components/glass-surface.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { motionSpring, spring } from "../motion/index.ts";
import { type ComposerVoice, ComposerVoiceButtons } from "../voice/controls.tsx";
import { ArgMenu, useArgMenu } from "./ArgMenu.tsx";
import type { ArgContext } from "./command-args.ts";
import { COMMANDS, type CommandInfo, completion, matchCommands } from "./commands.ts";
import { messageText } from "./MessageView.tsx";
import { useElementHeight } from "./ThreadChrome.tsx";
import type { ComposerAttach } from "./useAttachments.ts";

/** Every composer command, as typed (feature C9). */
/** The capsule's height at one line (§3.7). */
const ONE_LINE_PX = 44;
/** No key for this long: typing has stopped and the capsule may animate again. */
const TYPING_IDLE_MS = 400;

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

/** The item the next message is about (Feed "Ask about this"): a removable chip. */
export interface ComposerContextChip {
  title: string;
  /** Source name or host. */
  source: string | null;
  onRemove: () => void;
}

export interface ComposerProps {
  persona: string;
  /** What the message is about; the placeholder asks about it. */
  context?: ComposerContextChip | null;
  running: boolean;
  disabled?: boolean;
  quoting?: Message | null;
  onClearQuote?: () => void;
  /** How a message sent mid-turn goes; the follow-up strip changes it per queued message. */
  mode?: QueueMode;
  /**
   * The + button, the chips and the drop and paste targets. Absent when the thread's model takes
   * no files: the composer then shows none of them.
   */
  attach?: ComposerAttach;
  /** Files are still uploading: Send waits for them. */
  sendBlocked?: boolean;
  onDictate?: () => void;
  /** The host's dictation (#690): the mic button. */
  voice?: ComposerVoice;
  /** Stops the active run (`chat.cancel`). */
  onStop?: () => void;
  /** What the argument popup lists after `/model `, `/mode `: the thread's data. */
  argContext?: ArgContext;
}

/**
 * Composer (UI design §3.2): attachments, `/` commands, dictation, one Send/Stop pill, the reply
 * quote chip. While the agent works a message waits for the turn to end; the follow-up strip above
 * the composer can send it at once to steer or interrupt (§3.2). Built on assistant-ui's
 * composer primitives; sending goes through the external-store runtime's `onNew`.
 */
export function Composer({
  persona,
  context,
  running,
  disabled = false,
  quoting,
  onClearQuote,
  mode = "followUp",
  attach,
  sendBlocked = false,
  onDictate,
  voice,
  onStop,
  argContext,
}: ComposerProps): ReactElement {
  const menu = useCommandMenu();
  const argMenu = useArgMenu(argContext);
  const menuId = useId();
  const hintId = useId();
  const empty = useAuiState((s) => (s.composer.isEditing ? s.composer.text.trim() === "" : true));
  // One Send/Stop button (§5.2): Stop while a run works and the field is empty, Send otherwise
  // (a message sent mid-turn queues); accent fill only when there is text.
  const showStop = running && empty && onStop !== undefined;
  // Half the one-line height: a capsule at rest, the same corners as it grows.
  const capsuleRef = useRef<HTMLDivElement>(null);
  const height = useElementHeight(capsuleRef);
  const radius = Math.min(height || ONE_LINE_PX, ONE_LINE_PX) / 2;
  const round =
    "size-7 rounded-full cursor-default [&_svg:not([class*='size-'])]:size-4 disabled:opacity-100";
  const pickerRef = useRef<HTMLInputElement>(null);
  // Typing never animates the capsule (motion.md rule 4): while keys are coming, a wrapped line
  // grows it at once; chips, the menu and a pasted block still glide on `layout`.
  const [typing, setTyping] = useState(false);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markTyping = () => {
    setTyping(true);
    clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
  };
  useEffect(() => () => clearTimeout(typingIdle.current), []);
  // A chip that appears (Ask about this) puts the cursor in the input.
  const hasContext = context != null;
  useEffect(() => {
    if (hasContext) document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
  }, [hasContext]);
  const onDrop = (e: DragEvent) => {
    if (!attach || disabled || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    attach.onFiles(Array.from(e.dataTransfer.files));
  };
  const onDragOver = (e: DragEvent) => {
    if (attach && !disabled && e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (!attach || disabled || e.clipboardData.files.length === 0) return;
    e.preventDefault();
    attach.onFiles(Array.from(e.clipboardData.files));
  };
  return (
    // A floating Liquid Glass capsule (redesign-2026 §5.2; liquid-glass.md §6.3): refraction where
    // Chromium can, the next rung elsewhere, opaque under Reduce Transparency / Increase Contrast /
    // an inactive window. 44 px at one line with a radius of half that; it grows with `layout` on
    // spring.smooth up to 40% of the window, then scrolls. On focus a 1 px ring hairline inside.
    <m.div
      ref={capsuleRef}
      layout={!typing}
      transition={motionSpring(spring.smooth)}
      className="group/composer relative"
      data-testid="composer-capsule"
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <GlassSurface impl="refraction" radius={radius} as="div">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 shadow-[inset_0_0_0_1px_var(--ring)] group-focus-within/composer:opacity-100"
        />
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
                  {c.hint ? (
                    <span className="text-callout text-label-tertiary">{c.hint}</span>
                  ) : null}
                  <span className="ms-auto truncate text-callout text-label-secondary">
                    {c.description}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {argMenu.open ? <ArgMenu menu={argMenu} /> : null}
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
          {context ? (
            <ul
              aria-label={t("chat.context.label")}
              className="m-0 flex list-none flex-wrap gap-1.5 px-2 pt-2"
              data-testid="context-chip"
            >
              <li className="flex max-w-72 items-center gap-1.5 rounded-md bg-fill-tertiary py-1 ps-2 pe-1 text-callout">
                <Newspaper className="size-3.5 shrink-0 text-label-secondary" aria-hidden="true" />
                <span className="min-w-0 truncate text-label-primary">{context.title}</span>
                {context.source ? (
                  <span className="shrink-0 text-label-secondary">{context.source}</span>
                ) : null}
                <button
                  type="button"
                  onClick={context.onRemove}
                  aria-label={t("chat.context.remove", { title: context.title })}
                  className="inline-flex size-5 shrink-0 cursor-default items-center justify-center rounded-sm text-label-secondary hover:bg-fill-tertiary"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            </ul>
          ) : null}
          {attach && attach.refused.length > 0 ? (
            <div
              role="status"
              className="mx-2 mt-2 flex items-start gap-2 rounded-md bg-fill-tertiary px-2 py-1 text-callout text-label-secondary"
              data-testid="attach-refused"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {attach.refused.map((r) => (
                  <span key={`${r.name}-${r.reason}`} className="block">
                    {t(`chat.attach.refused.${r.reason}`, { name: r.name })}
                  </span>
                ))}
              </span>
              <button
                type="button"
                onClick={attach.onDismissRefused}
                aria-label={t("chat.attach.dismiss")}
                className="inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-sm hover:bg-fill-tertiary"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {attach && attach.chips.length > 0 ? (
            <ul
              aria-label={t("chat.attach.list")}
              className="m-0 flex list-none flex-wrap gap-1.5 px-2 pt-2"
              data-testid="attach-chips"
            >
              {attach.chips.map((c) => {
                const Icon = c.kind === "image" ? ImageIcon : FileText;
                return (
                  <li
                    key={c.key}
                    data-status={c.status}
                    className={cn(
                      "flex max-w-52 items-center gap-1.5 rounded-md bg-fill-tertiary py-1 ps-2 pe-1 text-callout",
                      c.status === "error" && "text-danger-text",
                    )}
                  >
                    {c.status === "uploading" ? (
                      <Loader2
                        className="size-3.5 shrink-0 animate-spin"
                        aria-label={t("chat.attach.uploading", { name: c.name })}
                      />
                    ) : c.status === "error" ? (
                      <AlertCircle
                        className="size-3.5 shrink-0"
                        aria-label={t("chat.attach.failed", { name: c.name })}
                      />
                    ) : (
                      <Icon className="size-3.5 shrink-0 text-label-secondary" aria-hidden="true" />
                    )}
                    <span className="min-w-0 truncate text-label-primary">{c.name}</span>
                    <button
                      type="button"
                      onClick={() => attach.onRemove(c.key)}
                      aria-label={t("chat.attach.remove", { name: c.name })}
                      className="inline-flex size-5 shrink-0 cursor-default items-center justify-center rounded-sm text-label-secondary hover:bg-fill-tertiary"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <m.div layout="position" className="flex items-end gap-1 p-1.5">
            {attach ? (
              <>
                <input
                  ref={pickerRef}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  accept={attach.accept}
                  data-testid="attach-input"
                  onChange={(e) => {
                    attach.onFiles(Array.from(e.target.files ?? []));
                    // The same file picked again must still fire.
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={round}
                  onClick={() => pickerRef.current?.click()}
                  aria-label={t("chat.composer.attach")}
                  disabled={disabled}
                >
                  <Plus aria-hidden="true" />
                </Button>
              </>
            ) : null}
            <ComposerPrimitive.Input
              rows={1}
              autoFocus
              disabled={disabled}
              placeholder={
                disabled
                  ? t("chat.composer.offline")
                  : context
                    ? t("chat.composer.placeholderArticle")
                    : t("chat.composer.placeholder", { persona })
              }
              aria-label={t("chat.composer.label", { persona })}
              data-composer-input=""
              onKeyDown={(e) => {
                if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") markTyping();
                // Files still uploading: Return waits for them, like the Send button.
                if (sendBlocked && e.key === "Enter" && !e.shiftKey && !menu.open) {
                  e.preventDefault();
                  return;
                }
                menu.onKeyDown(e);
                argMenu.onKeyDown(e);
              }}
              onPaste={onPaste}
              aria-autocomplete="list"
              aria-describedby={hintId}
              {...(menu.open
                ? {
                    "aria-controls": menuId,
                    "aria-activedescendant": `${menuId}-${menu.matches[menu.active]?.name ?? ""}`,
                  }
                : argMenu.open && !argMenu.loading
                  ? {
                      "aria-controls": argMenu.id,
                      "aria-activedescendant": argMenu.optionId(argMenu.active),
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
            {voice ? (
              <ComposerVoiceButtons voice={voice} disabled={disabled} className={round} />
            ) : null}
            {onDictate && !voice?.dictation ? (
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
                    disabled={disabled || empty || sendBlocked}
                  />
                }
              >
                <ArrowUp aria-hidden="true" />
              </ComposerPrimitive.Send>
            )}
          </m.div>
        </ComposerPrimitive.Root>
      </GlassSurface>
    </m.div>
  );
}
