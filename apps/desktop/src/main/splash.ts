import type { GatewayRunState, SupervisorMode } from "./supervisor.ts";

/**
 * The startup splash (owner request): a small window above the main one while the Gateway
 * launches. The main window still shows first (#441/#447); the splash closes the moment that
 * window has painted and the Gateway answers `/healthz`, hands over to the main window's
 * connection banner after a few seconds of waiting so it never sits in the way, and on a failure
 * shows the supervisor's reason with Show logs and Retry before handing over.
 */

export type HelperStep = "unbundled" | "starting" | "paired" | "offline";

export type SplashStatus =
  | { tone: "progress"; text: string }
  | { tone: "ready"; text: string }
  | { tone: "error"; text: string; reason: string; canShowLogs: boolean };

export interface SplashInputs {
  run: GatewayRunState;
  helper: HelperStep;
  healthy: boolean;
  painted: boolean;
}

export const SPLASH_TEXT = {
  starting: "Starting the Gateway…",
  installing: "Installing the launch agent…",
  waiting: "Waiting for the Gateway…",
  helper: "Launching the helper…",
  ready: "Ready",
  failed: "The Gateway didn't start",
} as const;

/** The one status line for what the supervisor, the Gateway and the helper are doing. */
export function splashStatus(i: SplashInputs): SplashStatus {
  if (i.healthy && i.painted) return { tone: "ready", text: SPLASH_TEXT.ready };
  if (i.run.kind === "stopped" && i.run.reason !== undefined && i.run.reason !== "quit") {
    return {
      tone: "error",
      text: SPLASH_TEXT.failed,
      reason: i.run.reason,
      canShowLogs: i.run.logs !== undefined || i.run.mode !== "external",
    };
  }
  if (i.healthy) {
    return {
      tone: "progress",
      text: i.helper === "starting" ? SPLASH_TEXT.helper : SPLASH_TEXT.waiting,
    };
  }
  if (i.run.kind === "starting" && i.run.step === "installing")
    return { tone: "progress", text: SPLASH_TEXT.installing };
  if (i.run.kind === "running" || (i.run.kind === "starting" && i.run.step === "waiting"))
    return { tone: "progress", text: SPLASH_TEXT.waiting };
  return { tone: "progress", text: SPLASH_TEXT.starting };
}

/** Whether to show the splash at all. */
export function shouldShowSplash(o: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  mode: SupervisorMode;
  /** The Gateway already answered at launch (attach mode): nothing to wait for. */
  healthyAtLaunch: boolean;
  /** The first-paint perf probe runs without extra windows. */
  probing?: boolean;
}): boolean {
  if (o.probing) return false;
  if (!o.packaged && o.env.PSYCHE_NO_SPLASH === "1") return false;
  if (o.mode === "external") return false;
  return !o.healthyAtLaunch;
}

/** The window the controller drives (Electron in the app, a fake in tests). */
export interface SplashView {
  render(status: SplashStatus): void;
  close(): void;
  onAction(cb: (action: "retry" | "logs") => void): void;
}

export interface SplashDeps {
  view: SplashView;
  retry: () => void;
  showLogs: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long "Ready" stays before the splash closes. */
  readyMs?: number;
  /** Waiting longer than this hands over to the main window's connection banner. */
  handoverMs?: number;
  /** How long a failure stays up (with Show logs and Retry) before handing over. */
  failureMs?: number;
}

export interface SplashController {
  update(patch: Partial<SplashInputs>): void;
  /** Closes now (the main window closed, the app quits). */
  close(): void;
  readonly closed: boolean;
  readonly status: SplashStatus;
}

export function createSplash(deps: SplashDeps): SplashController {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const readyMs = deps.readyMs ?? 300;
  const handoverMs = deps.handoverMs ?? 6_000;
  const failureMs = deps.failureMs ?? 12_000;
  let inputs: SplashInputs = {
    run: { kind: "unknown" },
    helper: "unbundled",
    healthy: false,
    painted: false,
  };
  let status = splashStatus(inputs);
  let closed = false;
  let timer: unknown;
  let timerFor: SplashStatus["tone"] | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimer(timer);
    deps.view.close();
  };
  const arm = (tone: SplashStatus["tone"], ms: number) => {
    if (timerFor === tone) return;
    if (timer !== undefined) clearTimer(timer);
    timerFor = tone;
    timer = setTimer(close, ms);
  };
  const render = () => {
    if (closed) return;
    status = splashStatus(inputs);
    deps.view.render(status);
    if (status.tone === "ready") arm("ready", readyMs);
    else if (status.tone === "error") arm("error", failureMs);
    else arm("progress", handoverMs);
  };

  deps.view.onAction((action) => {
    if (closed) return;
    if (action === "logs") {
      deps.showLogs();
      return;
    }
    inputs = { ...inputs, run: { kind: "unknown" }, healthy: false };
    timerFor = null;
    render();
    deps.retry();
  });
  render();

  return {
    update(patch) {
      if (closed) return;
      inputs = { ...inputs, ...patch };
      render();
    },
    close,
    get closed() {
      return closed;
    },
    get status() {
      return status;
    },
  };
}
