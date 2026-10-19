import { ComposerPrimitive } from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { messageText } from "./MessageView.tsx";

export const SLASH_COMMANDS = ["/model", "/schedule", "/forget", "/incognito"] as const;

export interface ComposerProps {
  persona: string;
  running: boolean;
  disabled?: boolean;
  quoting?: Message | null;
  onClearQuote?: () => void;
  mode: QueueMode;
  onModeChange: (mode: QueueMode) => void;
  onAttach?: () => void;
  onDictate?: () => void;
  /** Stops the active run (`chat.cancel`). */
  onStop?: () => void;
}

/**
 * Composer (UI design §3.2): attachments, `/` commands, dictation, one Send/Stop pill, the reply
 * quote chip and, while the agent works, how the message is queued. Built on assistant-ui's
 * composer primitives; sending goes through the external-store runtime's `onNew`.
 */
export function Composer({
  persona,
  running,
  disabled = false,
  quoting,
  onClearQuote,
  mode,
  onModeChange,
  onAttach,
  onDictate,
  onStop,
}: ComposerProps): ReactElement {
  return (
    <ComposerPrimitive.Root className="flex flex-col gap-1.5 rounded-xl border border-gray-6 bg-background p-2 focus-within:border-gray-8">
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
        {running ? (
          <label className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
            Send
            <select
              value={mode}
              onChange={(e) => onModeChange(e.target.value as QueueMode)}
              className="h-6 rounded border border-input bg-background px-1 text-xs text-foreground"
            >
              <option value="followUp">after this turn</option>
              <option value="steer">now, to steer</option>
              <option value="interrupt">now, interrupting</option>
            </select>
          </label>
        ) : (
          <span className="ml-1 text-xs text-muted-foreground">Type / for commands</span>
        )}
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
