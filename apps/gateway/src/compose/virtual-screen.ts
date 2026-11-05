import {
  PsycheError,
  type SideEffect,
  type VscreenApp,
  type VscreenCapability,
  VscreenFrame,
  VscreenFrameParams,
  VscreenInputParams,
  VscreenStartParams,
  VscreenStatus,
} from "@psyche/protocol";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The Gateway's virtual-screen service (linux design §5, §7): thin, validated calls to the Linux
 * host helper's `vscreen.*` capabilities, plus the three behaviours that live Gateway-side.
 *
 * - Ending a Task (`endTask`) asks the helper to close every app. An app that shows a "Save
 *   changes?" dialog is never discarded silently: the Task parks (awaiting_attention) with a card
 *   (`look` / `discard` / `keep_open`) instead of failing the call (§7.4). A virtual screen is
 *   unattended by design, so there is nobody to answer the dialog in the moment.
 * - Take-over (`setTakenOver`): while the owner drives the watch view the agent's calls wait in
 *   `agentGate()`, bounded, then fail with a retryable `user_in_control`. Owner input is never gated.
 * - The watch pane's frame pulls are limited to 4 a second per caller and only while the pane has
 *   reported itself visible (fed by `attention.report`).
 *
 * The module is standalone: it takes the helper through an injected `invoke`. Wiring (not done
 * here): compose/index.ts builds `invoke` over `NodeRegistry.hostHelper` + the Permission Broker
 * the way compose/computer.ts does, hands `park` to the Task runner, calls `setPaneVisible` from
 * the `attention.report` handler and `setTakenOver` from the watch view's take-over methods.
 *
 * Helper errors are rethrown untouched, so `details.reason` (`already_open_on_your_screen`,
 * `opened_elsewhere`, ...) reaches the model as the helper wrote it.
 */

/** `vscreen.stop` as the helper accepts it: the protocol shape plus `force` (discard unsaved work). */
export const VscreenStopRequest = Type.Object({
  closeApps: Type.Optional(Type.Boolean()),
  force: Type.Optional(Type.Boolean()),
});
export type VscreenStopRequest = Static<typeof VscreenStopRequest>;

export type VscreenParkAction = "look" | "discard" | "keep_open";
export const PARK_ACTIONS: readonly VscreenParkAction[] = ["look", "discard", "keep_open"];

export interface UnsavedChangesCard {
  kind: "unsaved_changes";
  apps: VscreenApp[];
  actions: VscreenParkAction[];
}

export type EndTaskResult = { ok: true } | { ok: false; parked: UnsavedChangesCard };

export type ResolveParkedResult =
  | { action: "look"; view: "computer-watch" }
  | { action: "discard" }
  | { action: "keep_open" };

export interface VscreenInvokeOptions {
  signal?: AbortSignal;
  /** The Permission Broker side effect of this call. */
  sideEffect: SideEffect;
  /** The broker target: always the one virtual screen. */
  target: string;
}

export interface VirtualScreenDeps {
  /**
   * Invokes a capability on the Linux host helper through the Permission Broker and returns its
   * result. A helper or broker failure is thrown as a `PsycheError` (details kept).
   */
  invoke(
    capability: VscreenCapability,
    params: Record<string, unknown>,
    options: VscreenInvokeOptions,
  ): Promise<unknown>;
  /** Parks the Task (awaiting_attention) with this card. */
  park(card: UnsavedChangesCard): void | Promise<void>;
  /** Milliseconds, for the frame limiter. */
  now(): number;
  /** How long an agent call waits for the owner to give control back. Default 30 s. */
  takeOverWaitMs?: number;
  /** Frame pulls allowed per caller per second. Default 4. */
  maxFramesPerSecond?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** `owner` is the watch pane; it is never held by take-over. Default `agent`. */
  actor?: "agent" | "owner";
  /** Rate-limit key for the watch pane. Default `watch`. */
  caller?: string;
}

export interface VirtualScreen {
  start(params?: unknown, opts?: CallOptions): Promise<VscreenStatus>;
  status(opts?: CallOptions): Promise<VscreenStatus>;
  frame(params?: unknown, opts?: CallOptions): Promise<VscreenFrame>;
  input(events: unknown, opts?: CallOptions): Promise<{ ok: boolean }>;
  stop(params?: unknown, opts?: CallOptions): Promise<{ ok: boolean }>;
  endTask(params?: { closeApps?: boolean }, opts?: CallOptions): Promise<EndTaskResult>;
  /** The parked card, if the Task is parked on unsaved changes. */
  parkedCard(): UnsavedChangesCard | null;
  resolveParked(action: VscreenParkAction, opts?: CallOptions): Promise<ResolveParkedResult>;
  setTakenOver(on: boolean): void;
  isTakenOver(): boolean;
  /** Resolves when the agent may act; rejects (retryable) if the owner holds control too long. */
  agentGate(signal?: AbortSignal): Promise<void>;
  setPaneVisible(visible: boolean): void;
}

const TARGET = "vscreen";
const DEFAULT_TAKE_OVER_WAIT_MS = 30_000;
const DEFAULT_FRAMES_PER_SECOND = 4;

function check(schema: TSchema, value: unknown, what: string): void {
  if (Value.Check(schema, value)) return;
  const first = [...Value.Errors(schema, value)][0];
  throw new PsycheError(
    "invalid_params",
    `${what}: ${first === undefined ? "bad shape" : `${first.path || "/"} ${first.message}`}`,
  );
}

function ackOf(value: unknown): { ok: boolean } {
  const ok = (value as { ok?: unknown } | null)?.ok;
  if (typeof ok === "boolean") return { ok };
  throw new PsycheError("internal", "the helper answered with an unexpected shape");
}

function resultOf<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new PsycheError("internal", `${what}: the helper answered with an unexpected shape`);
  }
  return value as Static<T>;
}

export function createVirtualScreen(deps: VirtualScreenDeps): VirtualScreen {
  const waitMs = deps.takeOverWaitMs ?? DEFAULT_TAKE_OVER_WAIT_MS;
  const maxFps = deps.maxFramesPerSecond ?? DEFAULT_FRAMES_PER_SECOND;
  let takenOver = false;
  let paneVisible = false;
  let card: UnsavedChangesCard | null = null;
  let waiters: Array<() => void> = [];
  const framePulls = new Map<string, number[]>();

  const call = (
    capability: VscreenCapability,
    params: Record<string, unknown>,
    sideEffect: SideEffect,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    deps.invoke(capability, params, {
      sideEffect,
      target: TARGET,
      ...(signal === undefined ? {} : { signal }),
    });

  function agentGate(signal?: AbortSignal): Promise<void> {
    if (!takenOver) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters = waiters.filter((w) => w !== release);
      };
      const release = (): void => {
        done();
        resolve();
      };
      const onAbort = (): void => {
        done();
        reject(new PsycheError("cancelled", "the call was cancelled"));
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new PsycheError(
            "user_in_control",
            "You are using the virtual screen; try again shortly.",
            { retryable: true, details: { reason: "taken_over" } },
          ),
        );
      }, waitMs);
      waiters.push(release);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  const gated = async (opts: CallOptions | undefined): Promise<void> => {
    if (opts?.actor !== "owner") await agentGate(opts?.signal);
  };

  function admitFrame(caller: string): void {
    if (!paneVisible) {
      throw new PsycheError("unavailable", "The watch view is not visible.", {
        details: { reason: "pane_hidden" },
      });
    }
    const t = deps.now();
    const recent = (framePulls.get(caller) ?? []).filter((at) => t - at < 1000);
    if (recent.length >= maxFps) {
      framePulls.set(caller, recent);
      throw new PsycheError("rate_limited", `At most ${maxFps} frames a second.`, {
        retryable: true,
        details: { reason: "frame_rate" },
      });
    }
    recent.push(t);
    framePulls.set(caller, recent);
  }

  const stopCall = async (
    params: VscreenStopRequest,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> => ackOf(await call("vscreen.stop", params, "write", signal));

  const statusCall = async (signal?: AbortSignal): Promise<VscreenStatus> =>
    resultOf(VscreenStatus, await call("vscreen.status", {}, "none", signal), "vscreen.status");

  return {
    async start(params, opts) {
      const p = params ?? {};
      check(VscreenStartParams, p, "vscreen.start");
      await gated(opts);
      return resultOf(
        VscreenStatus,
        await call("vscreen.start", p as Record<string, unknown>, "write", opts?.signal),
        "vscreen.start",
      );
    },

    async status(opts) {
      await gated(opts);
      return statusCall(opts?.signal);
    },

    async frame(params, opts) {
      const p = params ?? {};
      check(VscreenFrameParams, p, "vscreen.frame");
      if (opts?.actor === "owner") admitFrame(opts.caller ?? "watch");
      else await agentGate(opts?.signal);
      return resultOf(
        VscreenFrame,
        await call("vscreen.frame", p as Record<string, unknown>, "read", opts?.signal),
        "vscreen.frame",
      );
    },

    async input(events, opts) {
      const p = { events };
      check(VscreenInputParams, p, "vscreen.input");
      // The owner driving the watch view: allowed even while taken over.
      return ackOf(await call("vscreen.input", p, "write", opts?.signal));
    },

    async stop(params, opts) {
      const p = params ?? {};
      check(VscreenStopRequest, p, "vscreen.stop");
      await gated(opts);
      return stopCall(p as VscreenStopRequest, opts?.signal);
    },

    async endTask(params, opts) {
      const closeApps = params?.closeApps ?? true;
      const res = await stopCall({ closeApps }, opts?.signal);
      if (res.ok) {
        card = null;
        return { ok: true };
      }
      const status = await statusCall(opts?.signal);
      const unsaved = status.apps.filter((a) => a.hasUnsavedChanges === true);
      if (unsaved.length === 0) {
        throw new PsycheError("conflict", "The virtual screen could not be closed.", {
          details: { reason: "stop_refused" },
        });
      }
      card = { kind: "unsaved_changes", apps: unsaved, actions: [...PARK_ACTIONS] };
      await deps.park(card);
      return { ok: false, parked: card };
    },

    parkedCard: () => card,

    async resolveParked(action, opts) {
      if (card === null) {
        throw new PsycheError("conflict", "Nothing is parked on the virtual screen.", {
          details: { reason: "not_parked" },
        });
      }
      if (!PARK_ACTIONS.includes(action)) {
        throw new PsycheError("invalid_params", `unknown action ${String(action)}`);
      }
      if (action === "look") return { action, view: "computer-watch" };
      if (action === "discard") {
        const res = await stopCall({ closeApps: true, force: true }, opts?.signal);
        if (!res.ok) {
          throw new PsycheError("conflict", "The virtual screen could not be closed.", {
            details: { reason: "stop_refused" },
          });
        }
      }
      card = null;
      return { action };
    },

    setTakenOver(on) {
      takenOver = on;
      if (!on) {
        const release = waiters;
        waiters = [];
        for (const w of release) w();
      }
    },
    isTakenOver: () => takenOver,
    agentGate,

    setPaneVisible(visible) {
      paneVisible = visible;
      if (!visible) framePulls.clear();
    },
  };
}
