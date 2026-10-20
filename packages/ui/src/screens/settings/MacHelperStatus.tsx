import type { ReactElement } from "react";
import { StatusChip, type Tone } from "./shared.tsx";

/**
 * The bundled Mac helper as the desktop sees it (it launches the helper, which pairs with the
 * Gateway on its own). Shown in onboarding's Permissions step and Settings → Devices; nothing
 * waits on it.
 */
export type MacHelperStatus =
  | { kind: "unbundled" }
  | { kind: "starting" }
  | { kind: "paired" }
  | { kind: "offline"; reason?: string };

const VIEW: Record<MacHelperStatus["kind"], { tone: Tone; chip: string; text: string }> = {
  paired: {
    tone: "success",
    chip: "Connected",
    text: "Runs computer use, Messages, dictation, Keychain and notifications on this Mac.",
  },
  starting: {
    tone: "info",
    chip: "Starting…",
    text: "Psyche Helper is starting and connecting to the Gateway.",
  },
  offline: {
    tone: "neutral",
    chip: "Not connected",
    text: "Psyche works without it; it is started again on its own.",
  },
  unbundled: {
    tone: "neutral",
    chip: "Not installed",
    text: "This build of Psyche has no Mac helper.",
  },
};

export function MacHelperStatusRow({ state }: { state: MacHelperStatus }): ReactElement {
  const v = VIEW[state.kind];
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-gray-6 bg-gray-2 p-3"
      data-testid="mac-helper-status"
    >
      <p className="flex flex-wrap items-center gap-2 font-medium">
        Psyche Helper
        <StatusChip tone={v.tone}>{v.chip}</StatusChip>
      </p>
      <p className="text-sm text-muted-foreground">{v.text}</p>
      {state.kind === "offline" && state.reason ? (
        <p className="text-xs text-muted-foreground">Last try: {state.reason}.</p>
      ) : null}
    </div>
  );
}
