import { getDeviceFamily } from "@psyche/db";
import {
  type ErrorPayload,
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
import { type Call, type HandlerDef, hasScope } from "../context.ts";
import type { Gateway } from "../server.ts";
import type { HeadlessScreen } from "./headless-screen.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

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
 *   reported itself visible (fed by `attention.report`). Frames are never wider than
 *   `VSCREEN_MAX_FRAME_WIDTH`, so one always fits a helper message.
 * - Only the owner reaches the helper. A call is the owner's only when it carries this screen's
 *   `OwnerProof`: an object the composed part makes privately and hands out only inside its own
 *   `computerWatch.*` handlers, for a desktop-shell connection calling a `computerWatch.*`
 *   method. Nothing in the module exports a way to make or fetch one, and it is compared by
 *   identity, so no string, flag, parsed JSON or caller identity (a desktop-chat agent run also
 *   carries `desktopShell`) can stand in for it. Everything else is the agent's, and the composed part
 *   refuses an agent call (`agent_unbrokered`) until the agent's path (`apps.open` with
 *   `surface: "virtual_screen"`) goes through the Permission Broker.
 * - Giving control back (`computerWatch.takeOver { on: false }`) also lets go of every key and
 *   button the owner held, so the agent's next typing cannot turn into shortcuts.
 *
 * The service is standalone: it takes the helper through an injected `invoke`.
 * `composeVirtualScreen` (bottom of the file) is the part compose/index.ts registers: it builds
 * `invoke` over the Host's Linux helper (`NodeRegistry.hostHelper("vscreen.status")`), serves the
 * watch pane's `computerWatch.*` methods to the desktop shell, and publishes `computerWatch.parked`
 * when a Task parks. It starts nothing at idle: no timers, no subscriptions, and every method
 * answers `unavailable` while no Linux helper is connected.
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

/** The widest frame asked of the helper: wider frames could exceed the 1 MiB message limit. */
export const VSCREEN_MAX_FRAME_WIDTH = 1920;

/** Who a call is for: the owner's watch pane, or the agent. Decided here, never by a caller. */
export type VscreenActor = "agent" | "owner";

declare const OWNER_BRAND: unique symbol;
/**
 * Proof that a call comes from the owner's watch pane. A screen accepts exactly one object as its
 * proof (`VirtualScreenDeps.ownerProof`), compared by identity: a copy, a lookalike or JSON never
 * matches.
 */
export type OwnerProof = { readonly [OWNER_BRAND]: true };

const newProof = (): OwnerProof => Object.freeze(Object.create(null)) as OwnerProof;

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
  /** Who the call is for. An `agent` call must be decided by the Permission Broker. */
  actor: VscreenActor;
  /** The Permission Broker side effect of this call. */
  sideEffect: SideEffect;
  /** The broker target: always the one virtual screen. */
  target: string;
}

export interface VirtualScreenDeps {
  /**
   * Invokes a capability on the Linux host helper and returns its result. An `owner` call (the
   * watch pane, desktop shell only) goes straight to the helper; an `agent` call must go through
   * the Permission Broker, and the composed part refuses it until that path exists. A helper or
   * broker failure is thrown as a `PsycheError` (details kept).
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
  /**
   * The object this screen takes as the owner's proof. The composed part passes one it keeps to
   * itself; tests pass their own. Without it, no call is the owner's.
   */
  ownerProof?: OwnerProof;
}

export interface CallOptions {
  signal?: AbortSignal;
  /**
   * The watch pane's proof (`ownerProof`): its calls are the owner's and are never held by
   * take-over. Without it, a call is the agent's.
   */
  owner?: OwnerProof;
  /** Rate-limit key for the watch pane. Default `watch`. */
  caller?: string;
}

export interface VirtualScreen {
  start(params?: unknown, opts?: CallOptions): Promise<VscreenStatus>;
  status(opts?: CallOptions): Promise<VscreenStatus>;
  frame(params?: unknown, opts?: CallOptions): Promise<VscreenFrame>;
  input(events: unknown, opts?: CallOptions): Promise<{ ok: boolean }>;
  /** Lets go of every key and button held on the screen (the take-over ended). */
  release(opts?: CallOptions): Promise<{ ok: boolean }>;
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
  const proof = deps.ownerProof ?? newProof();
  const isOwner = (opts: CallOptions | undefined): boolean => opts?.owner === proof;

  const call = (
    capability: VscreenCapability,
    params: Record<string, unknown>,
    sideEffect: SideEffect,
    opts: CallOptions | undefined,
  ): Promise<unknown> =>
    deps.invoke(capability, params, {
      sideEffect,
      target: TARGET,
      actor: isOwner(opts) ? "owner" : "agent",
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
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
    if (!isOwner(opts)) await agentGate(opts?.signal);
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
    opts: CallOptions | undefined,
  ): Promise<{ ok: boolean }> => ackOf(await call("vscreen.stop", params, "write", opts));

  const statusCall = async (opts: CallOptions | undefined): Promise<VscreenStatus> =>
    resultOf(VscreenStatus, await call("vscreen.status", {}, "none", opts), "vscreen.status");

  return {
    async start(params, opts) {
      const p = params ?? {};
      check(VscreenStartParams, p, "vscreen.start");
      await gated(opts);
      return resultOf(
        VscreenStatus,
        await call("vscreen.start", p as Record<string, unknown>, "write", opts),
        "vscreen.start",
      );
    },

    async status(opts) {
      await gated(opts);
      return statusCall(opts);
    },

    async frame(params, opts) {
      const p = params ?? {};
      check(VscreenFrameParams, p, "vscreen.frame");
      if (isOwner(opts)) admitFrame(opts?.caller ?? "watch");
      else await agentGate(opts?.signal);
      const asked = p as VscreenFrameParams;
      const sent =
        asked.maxWidth !== undefined && asked.maxWidth > VSCREEN_MAX_FRAME_WIDTH
          ? { ...asked, maxWidth: VSCREEN_MAX_FRAME_WIDTH }
          : asked;
      return resultOf(
        VscreenFrame,
        await call("vscreen.frame", sent as Record<string, unknown>, "read", opts),
        "vscreen.frame",
      );
    },

    async input(events, opts) {
      const p = { events };
      check(VscreenInputParams, p, "vscreen.input");
      // The owner driving the watch view: allowed even while taken over.
      return ackOf(await call("vscreen.input", p, "write", opts));
    },

    async release(opts) {
      // `release` is not in the wire schema (like `force` on stop): the helper lets go of every
      // key and button it holds after the (empty) events.
      return ackOf(await call("vscreen.input", { events: [], release: true }, "write", opts));
    },

    async stop(params, opts) {
      const p = params ?? {};
      check(VscreenStopRequest, p, "vscreen.stop");
      await gated(opts);
      return stopCall(p as VscreenStopRequest, opts);
    },

    async endTask(params, opts) {
      const closeApps = params?.closeApps ?? true;
      const res = await stopCall({ closeApps }, opts);
      if (res.ok) {
        card = null;
        return { ok: true };
      }
      const status = await statusCall(opts);
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
        const res = await stopCall({ closeApps: true, force: true }, opts);
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

// --- The composed part ---------------------------------------------------------------------------

const REQUIRE_HELPER: ErrorPayload = {
  code: "unavailable",
  message: "The virtual screen needs the Psyche helper on Linux, and it is not connected.",
  details: { reason: "no_linux_helper" },
};

function fromPayload(e: ErrorPayload): PsycheError {
  return new PsycheError(e.code, e.message, {
    ...(e.details === undefined ? {} : { details: e.details }),
    ...(e.retryable === undefined ? {} : { retryable: e.retryable }),
  });
}

const AGENT_UNBROKERED: ErrorPayload = {
  code: "forbidden",
  message: "Psyche cannot use the virtual screen on its own yet.",
  details: { reason: "agent_unbrokered" },
};

/** The composed part's rule until the brokered agent path exists: owner calls only. */
export function refuseUnlessOwner(options: VscreenInvokeOptions): void {
  if (options.actor !== "owner") throw fromPayload(AGENT_UNBROKERED);
}

/** The `computerWatch.*` methods that drive the screen: the owner's clicks and keys. */
const TAKE_OVER_METHODS = new Set(["computerWatch.takeOver", "computerWatch.input"]);

/**
 * Who may use the watch pane (linux-helper-only design §7.4, B3; remote-gateway §4.1 rule 2):
 * - the desktop shell on the Host itself (loopback plus the per-launch secret), as before;
 * - a paired desktop app on another computer (`desktopApp`): a client device the owner approved
 *   with `deviceFamily: desktop`, holding `operator.write`. Take over (`takeOver`, `input`) also
 *   needs `operator.approvals`, because the owner's input is never gated or brokered.
 * Never a node, a machine, a browser page, a phone or the CLI, and nothing in `params` counts.
 * The private screen runs on the Host, so computer use stays Host-only (G5); a Client only
 * watches it and takes over.
 */
export function watchAccess(call: Pick<Call, "ctx" | "identity" | "method">): void {
  if (!call.method.startsWith("computerWatch.")) {
    throw new PsycheError("forbidden", "only the Psyche desktop app shows the virtual screen");
  }
  if (call.identity.desktopShell === true) return;
  const desktopApp =
    call.identity.role === "client" &&
    call.identity.hostHelper !== true &&
    call.identity.machine !== true &&
    getDeviceFamily(call.ctx.db, call.identity.deviceId) === "desktop";
  if (!desktopApp) {
    throw new PsycheError("forbidden", "only the Psyche desktop app shows the virtual screen");
  }
  if (!hasScope(call.identity, "operator.write")) {
    throw new PsycheError(
      "forbidden",
      "Watching the private screen needs a computer allowed to act (operator.write)",
      { details: { reason: "scope_missing", scope: "operator.write" } },
    );
  }
  if (TAKE_OVER_METHODS.has(call.method) && !hasScope(call.identity, "operator.approvals")) {
    throw new PsycheError(
      "forbidden",
      "Taking over the private screen needs a computer allowed to approve (operator.approvals)",
      { details: { reason: "scope_missing", scope: "operator.approvals" } },
    );
  }
}

/** The virtual-screen part, plus what the other users of the same screen need (B3). */
export interface ComposedVirtualScreen extends ComposedPart {
  /** For the agent browser on the screen: it waits while the owner has taken over. */
  readonly takeOver: {
    isTakenOver(): boolean;
    agentGate(signal?: AbortSignal): Promise<void>;
    /** Runs `listener` whenever the screen stopped (its apps, the browser among them, are gone). */
    onStopped(listener: () => void): () => void;
  };
  /** For headless computer use (`gateHeadlessRouter`): the take-over gate and Task end. */
  readonly screen: HeadlessScreen;
}

/**
 * The Gateway's virtual-screen part. The watch pane (desktop shell only) reaches the helper only
 * through it; the owner's own pane actions need no approval. The agent's use of the screen
 * (`apps.open` with `surface: "virtual_screen"`, later) must go through the Permission Broker
 * like every other computer-use tool: until that is wired, every `agent` call is refused here
 * instead of being sent to the helper unbrokered, and the screen is not handed to any other code.
 */
export function composeVirtualScreen(services: ComposeServices): ComposedVirtualScreen {
  let gateway: Gateway | undefined;
  // The owner's proof never leaves this closure: only the handlers below put it on a call.
  const proof = newProof();
  const stopped = new Set<() => void>();
  const vs = createVirtualScreen({
    ownerProof: proof,
    async invoke(capability, params, options) {
      refuseUnlessOwner(options);
      const helper = gateway?.context.nodes.hostHelper(capability);
      if (helper === undefined) throw fromPayload(REQUIRE_HELPER);
      const res = await helper.client.invoke(capability, params, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: 20_000,
      });
      if (!res.ok) {
        throw fromPayload(res.error ?? { code: "internal", message: "the helper failed" });
      }
      if (capability === "vscreen.start") {
        // The owner can watch from the first moment: open the watch pane in the desktop.
        services.publish("view.command", { command: "open", args: { pane: "computer-watch" } });
      }
      if (capability === "vscreen.stop" && (res.result as { ok?: unknown } | null)?.ok === true) {
        for (const listener of [...stopped]) listener();
      }
      return res.result;
    },
    park(card) {
      services.publish("computerWatch.parked", { apps: card.apps });
    },
    now: () => services.clock.now(),
  });

  // The owner's proof goes only on a `computerWatch.*` request from the desktop shell's own
  // connection or a paired desktop app's (`watchAccess`). A desktop-chat agent run carries
  // `desktopShell` too, but never this method; and nothing in `params` is read for it.
  const handler = (
    run: (params: Record<string, unknown>, owner: CallOptions) => unknown,
  ): HandlerDef => ({
    run(call: Call, params: unknown) {
      watchAccess(call);
      // Each device's frame pulls are limited on their own.
      const caller =
        call.identity.desktopShell === true ? "watch" : `watch:${call.identity.deviceId}`;
      return run((params ?? {}) as Record<string, unknown>, { owner: proof, caller });
    },
  });

  return {
    takeOver: {
      isTakenOver: () => vs.isTakenOver(),
      agentGate: (signal) => vs.agentGate(signal),
      onStopped(listener) {
        stopped.add(listener);
        return () => void stopped.delete(listener);
      },
    },
    screen: {
      isTakenOver: () => vs.isTakenOver(),
      agentGate: (signal) => vs.agentGate(signal),
      // The Gateway's own housekeeping at Task end (§7.4), not an agent action: it closes apps
      // the polite way (never `force`), so an app with unsaved changes parks the Task with the
      // card and the owner decides. The proof stays in this closure.
      async taskEnded() {
        await vs.endTask({ closeApps: true }, { owner: proof });
      },
    },
    start(gw) {
      gateway = gw;
    },
    stop() {
      gateway = undefined;
    },
    handlers: {
      "computerWatch.status": handler(async (_params, owner) => {
        const status = await vs.status(owner);
        return {
          status,
          parked: vs.parkedCard() !== null || status.apps.some((a) => a.hasUnsavedChanges === true),
        };
      }),
      "computerWatch.frame": handler(async (params, owner) => {
        // The pane reports itself visible or hidden through attention.report; a pane that never
        // reported is treated as visible.
        vs.setPaneVisible(!services.attention.paneHidden("vscreen"));
        return vs.frame(params, owner);
      }),
      "computerWatch.input": handler((params, owner) =>
        vs.input((params as { events: unknown }).events, owner),
      ),
      "computerWatch.takeOver": handler(async (params, owner) => {
        const on = (params as { on: boolean }).on;
        vs.setTakenOver(on);
        if (!on) {
          // Nothing the owner held stays pressed for the agent. A helper that is gone has
          // nothing pressed either, so giving control back never fails on it.
          await vs.release(owner).catch(() => undefined);
        }
        return { takenOver: vs.isTakenOver() };
      }),
      "computerWatch.stop": handler(async (params, owner) => {
        const p = params as { closeApps?: boolean; force?: boolean };
        if (p.force === true) return vs.stop({ closeApps: true, force: true }, owner);
        const end = await vs.endTask({ closeApps: p.closeApps ?? true }, owner);
        return { ok: end.ok };
      }),
      "computerWatch.resolveParked": handler((params, owner) =>
        vs.resolveParked((params as { action: VscreenParkAction }).action, owner),
      ),
    },
  };
}
