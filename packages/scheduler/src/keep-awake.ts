import { spawn as nodeSpawn } from "node:child_process";

/** The setting the owner turns on in Settings → Scheduled ("Keep this Mac awake while scheduled work runs"). */
export const KEEP_AWAKE_SETTING = "scheduled.keepAwake";

/** The part of a child process the hold needs. */
export interface PowerProcess {
  kill(): boolean | void;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  unref?(): void;
}

export interface KeepAwakeOptions {
  /** Starts the power assertion. Default: `caffeinate` (`node:child_process`). */
  spawn?: (command: string, args: string[]) => PowerProcess;
  /** The process the hold is tied to: `caffeinate -w` exits when it does. Default: this process. */
  pid?: number;
  /** Default: `process.platform`. The hold is macOS only. */
  platform?: NodeJS.Platform;
  /** Whether the owner has the toggle on (read at every sync). */
  enabled: () => boolean;
  /** Runs in progress, retries waiting included. */
  activeRuns: () => number;
  onError?: (error: unknown) => void;
}

/**
 * Keeps the Mac from idle-sleeping while scheduled work runs. It runs in the Gateway, which is the
 * process that runs the work (the LaunchAgent, with or without the desktop app), so no Electron
 * process has to stay open for it. The hold is `caffeinate -i`: system idle sleep is blocked and
 * display sleep is not. `-w <gateway pid>` makes caffeinate exit when the Gateway exits, crashes
 * included, so a hold can never outlive the run that needed it. `sync()` holds while the toggle is
 * on and a run is active, and releases otherwise.
 */
export class KeepAwake {
  readonly #o: KeepAwakeOptions;
  #proc: PowerProcess | undefined;

  constructor(options: KeepAwakeOptions) {
    this.#o = options;
  }

  /** Whether the hold is on right now. */
  holding(): boolean {
    return this.#proc !== undefined;
  }

  /** Brings the hold in line with the toggle and the active runs. Call on every run or setting change. */
  sync(): void {
    const platform = this.#o.platform ?? process.platform;
    const want = platform === "darwin" && this.#o.enabled() && this.#o.activeRuns() > 0;
    if (want && this.#proc === undefined) this.#start();
    else if (!want && this.#proc !== undefined) this.#release();
  }

  /** Releases the hold (the Gateway is stopping). */
  stop(): void {
    this.#release();
  }

  #start(): void {
    const spawn = this.#o.spawn ?? defaultSpawn;
    const pid = this.#o.pid ?? process.pid;
    let proc: PowerProcess;
    try {
      proc = spawn("caffeinate", ["-i", "-w", String(pid)]);
    } catch (e) {
      this.#o.onError?.(e);
      return;
    }
    this.#proc = proc;
    // If caffeinate ends on its own, the next sync asks for a new hold while a run is active.
    const forget = (...args: unknown[]) => {
      if (this.#proc === proc) this.#proc = undefined;
      if (args[0] instanceof Error) this.#o.onError?.(args[0]);
    };
    proc.on("exit", forget);
    proc.on("error", forget);
    proc.unref?.();
  }

  #release(): void {
    const proc = this.#proc;
    this.#proc = undefined;
    try {
      proc?.kill();
    } catch (e) {
      this.#o.onError?.(e);
    }
  }
}

function defaultSpawn(command: string, args: string[]): PowerProcess {
  return nodeSpawn(command, args, { stdio: "ignore" });
}
