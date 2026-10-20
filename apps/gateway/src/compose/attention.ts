import {
  type AttentionPane,
  type MethodParams,
  PsycheError,
  type ToolRegistration,
  type ToolRegistry,
  type ToolResult,
} from "@psyche/protocol";
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
/** How recent owner input must be for actions on sensitive apps and origins (§7.2 item 5). */
export const ATTENTION_WINDOW_MS = 5 * 60_000;

export class OwnerAttention {
  readonly #now: () => number;
  #lastInput: number | undefined;
  readonly #visible = new Map<AttentionPane, boolean>();
  readonly #waiters = new Set<() => void>();

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
    this.#wake();
  }

  report(pane: AttentionPane, visible: boolean, input: boolean): void {
    this.#visible.set(pane, visible);
    if (input) this.#lastInput = this.#now();
    this.#wake();
  }

  /** The owner gave input within the window and the pane is not reported hidden. */
  attended(pane: AttentionPane): boolean {
    const at = this.#lastInput;
    return at !== undefined && this.#now() - at <= ATTENTION_WINDOW_MS && !this.paneHidden(pane);
  }

  /** Resolves once the owner is back for `pane`; rejects `cancelled` when `signal` aborts. */
  waitForOwner(pane: AttentionPane, signal?: AbortSignal): Promise<void> {
    if (this.attended(pane)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!this.attended(pane)) return;
        done();
        resolve();
      };
      const onAbort = () => {
        done();
        reject(new PsycheError("cancelled", "the run was cancelled while waiting for the owner"));
      };
      const done = () => {
        this.#waiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted === true) return onAbort();
      this.#waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #wake(): void {
    for (const w of [...this.#waiters]) w();
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

/** The pane a tool's answer is about: browser tools, or computer use and app scripts. */
function paneOf(tool: string): AttentionPane | undefined {
  if (tool.startsWith("browser.")) return "browser";
  if (tool.startsWith("computer.") || tool.startsWith("apps.")) return "computer";
  return undefined;
}

function awaitingAttention(result: ToolResult): boolean {
  if (result.isError !== true) return false;
  const e = (result.output as { error?: { code?: string; details?: { reason?: string } } })?.error;
  return e?.code === "presence_required" && e.details?.reason === "awaiting_attention";
}

export interface ParkDeps {
  attention: OwnerAttention;
  /** The running call's Task, if it belongs to one. */
  taskOf(callId: string): string | undefined;
  /** Tell the owner once per park that a Task waits for them. */
  notify(taskId: string, tool: string): void;
}

/**
 * Pause-when-unwatched for Tasks (#272): when a `browser.*` / `computer.*` / `apps.*` call of a
 * Task answers `presence_required/awaiting_attention` (S08's browser gate, S14's helper), the
 * call waits, and with it the Task, until the owner is back (input within 5 minutes, pane not
 * reported hidden), then runs again: the executor checks attention itself every time. No
 * approval card; the owner gets one notification; cancelling the Task ends the wait. A chat
 * turn gets the answer as is, since the owner is in the conversation.
 */
export function parkWhenUnwatched(registry: ToolRegistry, deps: ParkDeps): ToolRegistry {
  return {
    list: () => registry.list(),
    get: (name) => registry.get(name),
    register(registration: ToolRegistration) {
      const pane = paneOf(registration.spec.name);
      if (pane === undefined) return registry.register(registration);
      const execute = registration.execute;
      return registry.register({
        ...registration,
        async execute(callId, params, signal, onUpdate) {
          let notified = false;
          for (;;) {
            const result = await execute(callId, params, signal, onUpdate);
            const taskId = awaitingAttention(result) ? deps.taskOf(callId) : undefined;
            if (taskId === undefined) return result;
            if (!notified) {
              notified = true;
              deps.notify(taskId, registration.spec.name);
            }
            try {
              await deps.attention.waitForOwner(pane, signal);
            } catch {
              return result;
            }
          }
        },
      });
    },
  };
}
