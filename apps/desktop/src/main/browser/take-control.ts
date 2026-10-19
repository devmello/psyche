/**
 * Take-control arbiter for one agent tab (spike 01 amendment 3, gotcha 3). Pure: the host feeds
 * it Electron's input events and the agent's `Input.*` command boundaries.
 *
 * Rules (measured on Electron 44.9):
 * - Keyboard: `before-input-event` `keyDown` is the user. CDP `Input.*` never fires
 *   `before-input-event`, so keyboard needs no timing heuristics.
 * - Mouse: `input-event` `mouseDown` (or `touchStart`), or `mouseWheel` at least `wheelGraceMs`
 *   after the agent's last wheel command ended, is the user — but only while no agent `Input.*`
 *   command is in flight (CDP mouse echoes arrive inside the `sendCommand` await). Hover never
 *   grabs; `mouseMove`/`mouseUp`/other keys only extend a hold that is already active.
 * - Release after `idleMs` (1.5 s) without user input, unless the Take control button made the
 *   hold sticky; the Release button ends it at once.
 *
 * Time-window "grace after agent input" heuristics must not be used for keyboard or clicks: with
 * an agent typing every 25 ms the window never closes and the user's keys are misread as echoes.
 */

export type ControlState = "agent" | "user";
export type ControlVia = "keyboard" | "mouse" | "button" | "release" | "idle";

export interface TakeControlOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Idle time before an implicit hold is released (default 1500 ms). */
  idleMs?: number;
  /** Wheel events this soon after an agent wheel are its echoes (default 50 ms). */
  wheelGraceMs?: number;
  onChange?: (state: ControlState, via: ControlVia) => void;
}

export const DEFAULT_IDLE_MS = 1_500;
export const DEFAULT_WHEEL_GRACE_MS = 50;

const MOUSE_GRAB = new Set(["mouseDown", "touchStart"]);
const MOUSE_EXTEND = new Set([
  "mouseMove",
  "mouseUp",
  "mouseWheel",
  "touchMove",
  "touchEnd",
  "gestureScrollBegin",
  "gestureScrollUpdate",
  "gestureScrollEnd",
]);

function isWheelCommand(method: string, params: Record<string, unknown> | undefined): boolean {
  if (method === "Input.synthesizeScrollGesture") return true;
  return (
    (method === "Input.dispatchMouseEvent" || method === "Input.emulateTouchFromMouseEvent") &&
    params?.type === "mouseWheel"
  );
}

export class TakeControl {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly idleMs: number;
  private readonly wheelGraceMs: number;
  private readonly listeners = new Set<(state: ControlState, via: ControlVia) => void>();
  private current: ControlState = "agent";
  private stickyHold = false;
  private holdUntil = 0;
  private agentDepth = 0;
  private lastAgentWheelEnd = Number.NEGATIVE_INFINITY;
  private timer: unknown;
  private disposed = false;

  constructor(opts: TakeControlOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined));
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.wheelGraceMs = opts.wheelGraceMs ?? DEFAULT_WHEEL_GRACE_MS;
    if (opts.onChange) this.listeners.add(opts.onChange);
  }

  get state(): ControlState {
    return this.current;
  }

  get sticky(): boolean {
    return this.stickyHold;
  }

  /** Agent `Input.*` commands currently in flight. */
  get agentInputDepth(): number {
    return this.agentDepth;
  }

  isUserInControl(): boolean {
    return this.current === "user";
  }

  onChange(cb: (state: ControlState, via: ControlVia) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** `webContents` `before-input-event` (native keyboard only; CDP never fires it). */
  onBeforeInputEvent(type: string): void {
    if (type === "keyDown" || type === "rawKeyDown") this.grab("keyboard");
    else this.extend();
  }

  /** `webContents` `input-event` (native and CDP input alike). */
  onInputEvent(type: string): void {
    if (this.agentDepth > 0) return;
    if (MOUSE_GRAB.has(type)) {
      this.grab("mouse");
      return;
    }
    if (type === "mouseWheel" && this.now() - this.lastAgentWheelEnd >= this.wheelGraceMs) {
      this.grab("mouse");
      return;
    }
    if (MOUSE_EXTEND.has(type)) this.extend();
  }

  agentInputStart(_method: string, _params?: Record<string, unknown>): void {
    this.agentDepth++;
  }

  agentInputEnd(method: string, params?: Record<string, unknown>): void {
    if (this.agentDepth > 0) this.agentDepth--;
    if (isWheelCommand(method, params)) this.lastAgentWheelEnd = this.now();
  }

  /** The Take control button (true) or Release (false). */
  setSticky(on: boolean): void {
    if (this.disposed) return;
    if (on) {
      this.stickyHold = true;
      this.cancelTimer();
      this.set("user", "button");
      return;
    }
    const wasHeld = this.stickyHold || this.current === "user";
    this.stickyHold = false;
    this.holdUntil = 0;
    this.cancelTimer();
    if (wasHeld) this.set("agent", "release");
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
  }

  private grab(via: "keyboard" | "mouse"): void {
    if (this.disposed) return;
    this.holdUntil = this.now() + this.idleMs;
    if (this.stickyHold) return;
    this.set("user", via);
    this.armTimer();
  }

  private extend(): void {
    if (this.current !== "user" || this.stickyHold || this.disposed) return;
    this.holdUntil = this.now() + this.idleMs;
  }

  private armTimer(): void {
    if (this.timer !== undefined) return;
    const fire = () => {
      this.timer = undefined;
      if (this.stickyHold || this.current !== "user") return;
      const left = this.holdUntil - this.now();
      if (left > 0) {
        this.timer = this.setTimer(fire, left);
        return;
      }
      this.set("agent", "idle");
    };
    this.timer = this.setTimer(fire, Math.max(0, this.holdUntil - this.now()));
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private set(state: ControlState, via: ControlVia): void {
    if (this.current === state) return;
    this.current = state;
    for (const l of this.listeners) l(state, via);
  }
}
