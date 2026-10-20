import { type DisclosureLevel, useSettings } from "@psyche/ui";
import { type ReactElement, useCallback, useId } from "react";

/**
 * Transcript view modes (feature E11; docs/06 §3.2): Normal keeps tool calls collapsed, Thinking
 * shows the action rows, Verbose shows raw tool I/O. They map onto the kit's disclosure levels
 * 0 / 1 / 2 and ⌃O cycles them. The mode persists per user in the cosmetic setting
 * `ui.transcriptMode` (no admin needed), so every device of the user shares it.
 */

export const TRANSCRIPT_MODE_KEY = "ui.transcriptMode";
export type TranscriptMode = "normal" | "thinking" | "verbose";
export const MODES: readonly { mode: TranscriptMode; level: DisclosureLevel; label: string }[] = [
  { mode: "normal", level: 0, label: "Normal" },
  { mode: "thinking", level: 1, label: "Thinking" },
  { mode: "verbose", level: 2, label: "Verbose" },
];
export const DEFAULT_MODE: TranscriptMode = "thinking";

export function levelOf(mode: unknown): DisclosureLevel {
  return (MODES.find((m) => m.mode === mode) ?? MODES.find((m) => m.mode === DEFAULT_MODE))
    ?.level as DisclosureLevel;
}

export function modeOf(level: DisclosureLevel): TranscriptMode {
  return (MODES.find((m) => m.level === level) ?? MODES[1])?.mode ?? DEFAULT_MODE;
}

/** The persisted transcript mode as a disclosure level, and a setter that writes it. */
export function useTranscriptMode(): [DisclosureLevel, (level: DisclosureLevel) => void] {
  const { settings, set } = useSettings();
  const level = levelOf(settings[TRANSCRIPT_MODE_KEY]);
  const setLevel = useCallback(
    (next: DisclosureLevel) => {
      void set(TRANSCRIPT_MODE_KEY, modeOf(next)).catch(() => undefined);
    },
    [set],
  );
  return [level, setLevel];
}

export function TranscriptModeBar({
  level,
  onChange,
  incognito = false,
}: {
  level: DisclosureLevel;
  onChange: (level: DisclosureLevel) => void;
  incognito?: boolean;
}): ReactElement {
  const id = useId();
  return (
    <div
      className="flex items-center gap-2 border-b border-gray-5 px-4 py-1 text-xs text-muted-foreground"
      data-testid="transcript-mode"
    >
      {incognito ? (
        <span
          className="rounded-full border border-gray-7 px-2 py-0.5"
          title="Memory-only; expires after 24 h"
        >
          Incognito
        </span>
      ) : null}
      <fieldset className="ml-auto flex items-center gap-2">
        <legend className="sr-only">Transcript view mode</legend>
        <span aria-hidden="true">View</span>
        <div className="flex rounded-md border border-gray-6">
          {MODES.map((m) => (
            <label
              key={m.mode}
              className={`inline-flex min-h-6 cursor-pointer items-center px-2 py-0.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${m.level === level ? "bg-gray-4 text-foreground" : ""}`}
              title={`${m.label} (⌃O cycles)`}
            >
              <input
                type="radio"
                name={`${id}-mode`}
                className="sr-only"
                value={m.mode}
                checked={m.level === level}
                onChange={() => onChange(m.level)}
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
