import { CircleAlert } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";

/**
 * A shortcut recorder (docs/ui-audit.md decision 9): focus it, press the keys, and it records an
 * Electron accelerator ("Control+Alt+D"). Shortcuts macOS or Psyche reserve, and ones the shell
 * reports as taken by another app, are refused with an approval-tone hint and never saved.
 */

export type ShortcutCheck = "ok" | "taken" | "invalid";

/** Shortcuts macOS or Psyche already use; recording one is refused without asking the shell. */
export const RESERVED_SHORTCUTS: Readonly<Record<string, string>> = {
  "Command+Space": "Spotlight",
  "Control+Space": "input source switching",
  "Command+Tab": "the app switcher",
  "Command+Q": "quitting apps",
  "Command+W": "closing windows",
  "Command+H": "hiding apps",
  "Command+M": "minimising windows",
  "Command+`": "switching windows",
  "Command+Shift+3": "screenshots",
  "Command+Shift+4": "screenshots",
  "Command+Shift+5": "screenshots",
  "Command+Alt+Escape": "Force Quit",
  "Alt+Space": "Psyche's quick entry",
  "Control+Alt+Space": "Psyche's quick entry",
};

const CODE_KEY: Record<string, string> = {
  Space: "Space",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  Tab: "Tab",
};

/**
 * The accelerator a key press makes, by physical key (so Option+D is "Alt+D", not "∂"), or
 * `null` while only modifiers are down or for a key no shortcut uses. Needs a modifier unless
 * the key is a function key.
 */
export function acceleratorOf(e: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODE_KEY[e.code];
  if (key === undefined) return null;
  const mods = [
    e.metaKey ? "Command" : null,
    e.ctrlKey ? "Control" : null,
    e.altKey ? "Alt" : null,
    e.shiftKey ? "Shift" : null,
  ].filter((m): m is string => m !== null);
  if (mods.length === 0 && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join("+");
}

const SYMBOL: Record<string, string> = { Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };

function Keys({ accelerator }: { accelerator: string }): ReactElement {
  return (
    <span className="inline-flex gap-1">
      {accelerator.split("+").map((part) => (
        <Kbd key={part}>{SYMBOL[part] ?? part}</Kbd>
      ))}
    </span>
  );
}

/** "Command+Shift+D" → "⌘⇧D", for messages. */
export function shortcutText(accelerator: string): string {
  return accelerator
    .split("+")
    .map((p) => SYMBOL[p] ?? p)
    .join("");
}

export function ShortcutRecorder({
  label,
  description,
  value,
  onChange,
  onCheck,
  takenNow,
}: {
  label: string;
  description?: string;
  /** The saved accelerator; "" means off. */
  value: string;
  onChange: (accelerator: string) => void;
  /** Asks the shell whether another app holds the shortcut (desktop). */
  onCheck?: (accelerator: string) => Promise<ShortcutCheck>;
  /** The shell reported the saved shortcut as taken after registering it. */
  takenNow?: string;
}): ReactElement {
  const id = useId();
  const [recording, setRecording] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const accept = async (accelerator: string) => {
    setRecording(false);
    const reserved = RESERVED_SHORTCUTS[accelerator];
    if (reserved !== undefined) {
      setRefused(`${shortcutText(accelerator)} is used by ${reserved}. Pick another shortcut.`);
      return;
    }
    if (onCheck) {
      setChecking(true);
      const verdict = await onCheck(accelerator).catch((): ShortcutCheck => "ok");
      setChecking(false);
      if (verdict !== "ok") {
        setRefused(
          verdict === "taken"
            ? `${shortcutText(accelerator)} is taken by another app. Pick another shortcut.`
            : `${shortcutText(accelerator)} can't be a system-wide shortcut. Pick another one.`,
        );
        return;
      }
    }
    setRefused(null);
    onChange(accelerator);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) return;
    e.preventDefault();
    if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      setRecording(false);
      return;
    }
    if ((e.code === "Backspace" || e.code === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setRecording(false);
      setRefused(null);
      onChange("");
      return;
    }
    const accelerator = acceleratorOf(e);
    if (accelerator !== null) void accept(accelerator);
  };

  const hint =
    refused ??
    (takenNow && value !== ""
      ? `${shortcutText(takenNow)} is taken by another app, so it does nothing. Pick another shortcut.`
      : null);

  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="font-medium text-foreground">
        {label}
      </span>
      {description ? (
        <p id={`${id}-desc`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-labelledby={`${id}-label`}
          aria-describedby={
            [description ? `${id}-desc` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") ||
            undefined
          }
          aria-pressed={recording}
          className="flex h-8 min-w-44 items-center rounded-md border border-input bg-background px-2.5 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:border-ring"
          onClick={() => {
            setRefused(null);
            setRecording(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
        >
          {checking ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : recording ? (
            <span className="text-muted-foreground">Press the shortcut…</span>
          ) : value ? (
            <Keys accelerator={value} />
          ) : (
            <span className="text-muted-foreground">Off. Click to record</span>
          )}
        </button>
        {value && !recording ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setRefused(null);
              onChange("");
            }}
          >
            Turn off
          </Button>
        ) : null}
      </div>
      {hint ? (
        <p
          id={`${id}-hint`}
          role="status"
          className="flex items-center gap-1.5 text-xs text-approval-text"
        >
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {hint}
        </p>
      ) : null}
    </div>
  );
}
