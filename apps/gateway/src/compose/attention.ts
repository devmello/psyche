import { type AttentionPane, type MethodParams, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Whether the owner is watching (pause-when-unwatched, docs/05 §7.2 item 5; #272), for the
 * executors that act on sensitive apps and origins (computer use here; the browser can read the
 * same). Two signals:
 *
 * - **input**: the owner's own messages and approval answers on the bus, and the desktop's
 *   `attention.report {input: true}`;
 * - **pane visibility**: the desktop's `attention.report {pane, visible}`. A pane the desktop
 *   never reported counts as unknown, not hidden, so the check stays the input check until the
 *   desktop reports.
 *
 * Only the desktop shell's own connection may report (#278's `identity.desktopShell`).
 */
export class OwnerAttention {
  readonly #now: () => number;
  #lastInput: number | undefined;
  readonly #visible = new Map<AttentionPane, boolean>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** When the owner last gave input, if ever. */
  lastInput(): number | undefined {
    return this.#lastInput;
  }

  /** True only when the desktop reported this pane hidden. */
  paneHidden(pane: AttentionPane): boolean {
    return this.#visible.get(pane) === false;
  }

  noteInput(): void {
    this.#lastInput = this.#now();
  }

  report(pane: AttentionPane, visible: boolean, input: boolean): void {
    this.#visible.set(pane, visible);
    if (input) this.noteInput();
  }

  /** A bus frame: the owner's own chat message or an answer from one of their devices. */
  observe(frame: string): void {
    const f = JSON.parse(frame) as { event?: string; payload?: Record<string, unknown> };
    const p = f.payload ?? {};
    if (f.event === "chat.message") {
      const m = p.message as { role?: string; provenance?: string } | undefined;
      if (m?.role === "user" && m.provenance === "owner") this.noteInput();
    } else if (f.event === "approval.updated") {
      const a = p.approval as { decidedBy?: { deviceId?: string } | null } | undefined;
      if (typeof a?.decidedBy?.deviceId === "string") this.noteInput();
    }
  }
}

export function attentionHandlers(attention: OwnerAttention): Record<string, HandlerDef> {
  return {
    "attention.report": {
      run(call: Call, params: MethodParams<"attention.report">) {
        if (call.identity.desktopShell !== true) {
          throw new PsycheError("forbidden", "only the Psyche desktop app reports attention");
        }
        attention.report(params.pane, params.visible, params.input === true);
        return { ok: true as const };
      },
    },
  };
}
