import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
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
  return (
    <ComposerPrimitive.Root className="relative flex flex-col gap-1.5 rounded-xl border border-gray-6 bg-background p-2 focus-within:border-gray-8">
      {menu.open ? (
        <div
          id={menuId}
          role="listbox"
          aria-label="Commands"
          className="absolute bottom-full left-0 z-10 mb-1 max-h-72 w-full overflow-y-auto rounded-lg border border-gray-6 bg-background p-1 shadow-md"
        >
          {menu.matches.map((c, i) => (
            <div
              key={c.name}
              id={`${menuId}-${c.name}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === menu.active}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-sm",
                i === menu.active && "bg-gray-4",
              )}
              onMouseDown={(e) => {
                // Keep focus in the composer while picking.
                e.preventDefault();
                menu.pick(c);
              }}
            >
              <span className="font-mono font-medium text-foreground">/{c.name}</span>
              {c.hint ? <span className="text-xs text-muted-foreground">{c.hint}</span> : null}
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {c.description}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {quoting ? (
        <div className="flex items-center gap-2 rounded-md bg-gray-2 px-2 py-1 text-sm">
          <span className="text-muted-foreground">Quoting:</span>
          <span className="min-w-0 flex-1 truncate">"{messageText(quoting)}"</span>
          <button
            type="button"
            onClick={onClearQuote}
            aria-label="Remove quote"
            className="rounded p-0.5 text-muted-foreground hover:bg-gray-4"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        disabled={disabled}
        placeholder={disabled ? "Psyche can't reach the Gateway" : `Message ${persona}…`}
        aria-label={`Message ${persona}`}
        onKeyDown={menu.onKeyDown}
        aria-autocomplete="list"
        {...(menu.open
          ? {
              "aria-controls": menuId,
              "aria-activedescendant": `${menuId}-${menu.matches[menu.active]?.name ?? ""}`,
            }
          : {})}
        className="max-h-48 min-h-9 resize-none bg-transparent px-1.5 py-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-1">
        {onAttach ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onAttach}
            aria-label="Attach files"
            disabled={disabled}
          >
            <Paperclip aria-hidden="true" />
          </Button>
        ) : null}
        {onDictate ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDictate}
            aria-label="Dictate (hold fn)"
            disabled={disabled}
          >
            <Mic aria-hidden="true" />
          </Button>
        ) : null}
        <span className="ml-1 text-caption text-muted-foreground">
          {!running
            ? "Type / for commands"
            : mode === "followUp"
              ? `Sends when ${persona} finishes this turn`
              : mode === "steer"
                ? `Sends now, to steer ${persona}`
                : `Sends now, interrupting ${persona}`}
        </span>
        <span className="ml-auto" />
        {running && onStop ? (
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label="Stop the run (Esc)"
            onClick={onStop}
          >
            <Square aria-hidden="true" />
          </Button>
        ) : null}
        <ComposerPrimitive.Send
          render={<Button size="icon-sm" aria-label="Send" disabled={disabled} />}
        >
          <ArrowUp aria-hidden="true" />
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
