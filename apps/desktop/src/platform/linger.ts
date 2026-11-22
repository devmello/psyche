import { userInfo } from "node:os";
import type { Runner } from "../main/supervisor-base.ts";
import { isLinux, type Platform } from "./index.ts";

/**
 * "Keep Psyche running after I log out" (design §2.3), Settings › General. systemd stops a user's
 * services at logout unless lingering is on (`loginctl enable-linger`). Off by default: the
 * Gateway then stops at logout like the Mac's LaunchAgent. Polkit lets a user change their own
 * lingering, so there is no admin prompt.
 */
export const LINGER_KEY = "general.keepRunningAfterLogout";

export const loginctl = {
  show: (user: string) => ["show-user", user, "-p", "Linger", "--value"],
  enable: () => ["enable-linger"],
  disable: () => ["disable-linger"],
} as const;

export class Linger {
  readonly #run: Runner;
  readonly #platform: Platform | undefined;
  readonly #user: string;
  readonly #warn: ((message: string) => void) | undefined;

  constructor(
    run: Runner,
    o: { platform?: Platform; user?: string; warn?: (m: string) => void } = {},
  ) {
    this.#run = run;
    this.#platform = o.platform;
    this.#user = o.user ?? userInfo().username;
    this.#warn = o.warn;
  }

  /** Whether lingering is on; undefined when it cannot be read (no logind, not Linux). */
  async status(): Promise<boolean | undefined> {
    if (!isLinux(this.#platform)) return undefined;
    const res = await this.#run("loginctl", [...loginctl.show(this.#user)]);
    if (res.code !== 0) return undefined;
    const v = res.stdout.trim();
    return v === "yes" ? true : v === "no" ? false : undefined;
  }

  /** Turns lingering on or off for the current user. Returns whether the request worked. */
  async set(value: unknown): Promise<boolean> {
    if (!isLinux(this.#platform)) return false;
    const on = value === true;
    // Nothing to do when it already is what the owner asked for: no call, no log noise.
    if ((await this.status()) === on) return true;
    const res = await this.#run("loginctl", on ? [...loginctl.enable()] : [...loginctl.disable()]);
    if (res.code !== 0) {
      this.#warn?.(`could not change lingering: ${(res.stderr || res.stdout).trim()}`);
      return false;
    }
    return true;
  }

  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    const entry = entries.find((e) => e.key === LINGER_KEY);
    if (entry) void this.set(entry.value);
  }

  /** Reads the stored setting once paired. Never set: leaves lingering as the owner has it. */
  async load(call: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    try {
      const res = (await call("settings.get", { keys: [LINGER_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      const value = res.settings?.[LINGER_KEY];
      if (value !== undefined) await this.set(value);
    } catch (err) {
      this.#warn?.(`could not read ${LINGER_KEY}: ${String(err)}`);
    }
  }
}
