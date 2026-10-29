/**
 * Psyche in the Dock and ⌘-Tab only while a window is open. With no window left (main, Settings,
 * a pane's pop-out) the app switches to the macOS "accessory" activation policy: no Dock icon, no
 * ⌘-Tab entry, only the menu-bar item, while the app, the Gateway link and the global shortcuts
 * keep working. Opening a window switches back to "regular" first, so it appears in ⌘-Tab.
 *
 * Panels do not count as windows: the menu-bar panel, the screen-ask panel and region overlay,
 * the quick-entry bar and the dictation HUD all work in accessory mode (they are non-activating
 * or opened by the owner from the menu bar or a shortcut).
 *
 * The owner's setting `appearance.showInDock` ("Show in Dock when no windows are open", default
 * off) keeps the Dock icon the way it was before this existed.
 */

export const SHOW_IN_DOCK_KEY = "appearance.showInDock";

/** While ⌘H has the app hidden, how often to look again (rarely: it is a waiting state). */
const HIDDEN_RECHECK_MS = 2000;

type Policy = "regular" | "accessory";

/** The slice of Electron's `app` the policy drives. */
export interface DockApp {
  setActivationPolicy(policy: Policy | "prohibited"): void;
  focus(options?: { steal?: boolean }): void;
  /** ⌘H: a hidden app keeps its Dock icon, or nothing could bring it back. */
  isHidden?(): boolean;
}

export interface DockPolicyOptions {
  app: DockApp;
  platform?: NodeJS.Platform;
  /**
   * How long no window must have been open before the Dock icon goes. A window that closes as
   * another opens (Settings over the main window) must not flash the icon off and on.
   */
  graceMs?: number;
  /** Test seams. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  warn?: (message: string) => void;
}

/** The setting's value: only `true` keeps the icon; unset and anything else is the default (off). */
export function showInDock(value: unknown): boolean {
  return value === true;
}

export class DockPolicy {
  readonly #o: DockPolicyOptions;
  readonly #darwin: boolean;
  #policy: Policy = "regular";
  #windows = 0;
  #showAlways = false;
  #timer: unknown;

  constructor(options: DockPolicyOptions) {
    this.#o = options;
    this.#darwin = (options.platform ?? process.platform) === "darwin";
  }

  get policy(): Policy {
    return this.#policy;
  }

  /**
   * A window is about to be shown: the app must be a regular one first, or the window opens
   * without a ⌘-Tab entry and without keyboard focus. True when this switched the policy; the
   * caller then raises the app after showing the window.
   */
  beforeShow(): boolean {
    this.#cancel();
    return this.#set("regular");
  }

  /** After a window was shown by `beforeShow`'s caller: takes the focus the switch cost. */
  afterShow(switched: boolean): void {
    if (switched) this.#o.app.focus({ steal: true });
  }

  /** The number of windows now open (visible or minimized; panels are not counted). */
  windowsChanged(count: number): void {
    this.#windows = count;
    if (count > 0) {
      this.#cancel();
      this.#set("regular");
    } else {
      this.#schedule();
    }
  }

  /** The "Show in Dock when no windows are open" setting. */
  setShowInDock(value: unknown): void {
    this.#showAlways = showInDock(value);
    if (this.#showAlways) {
      this.#cancel();
      this.#set("regular");
    } else if (this.#windows === 0) {
      this.#schedule();
    }
  }

  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    const entry = entries.find((e) => e.key === SHOW_IN_DOCK_KEY);
    if (entry) this.setShowInDock(entry.value);
  }

  /** Reads the stored setting once paired; unset is the default (the icon leaves the Dock). */
  async load(call: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    try {
      const res = (await call("settings.get", { keys: [SHOW_IN_DOCK_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      this.setShowInDock(res.settings?.[SHOW_IN_DOCK_KEY]);
    } catch (err) {
      this.#o.warn?.(`could not read ${SHOW_IN_DOCK_KEY}: ${String(err)}`);
    }
  }

  /** Quitting: leave the policy alone and drop a pending switch. */
  dispose(): void {
    this.#cancel();
  }

  #schedule(graceMs = this.#o.graceMs ?? 150): void {
    this.#cancel();
    if (this.#showAlways) return;
    const run = () => {
      this.#timer = undefined;
      if (this.#windows !== 0 || this.#showAlways) return;
      if (this.#o.app.isHidden?.() === true) return this.#schedule(HIDDEN_RECHECK_MS);
      this.#set("accessory");
    };
    if (graceMs <= 0) run();
    else this.#timer = (this.#o.setTimer ?? setTimeout)(run, graceMs);
  }

  #cancel(): void {
    if (this.#timer === undefined) return;
    (this.#o.clearTimer ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
    this.#timer = undefined;
  }

  #set(policy: Policy): boolean {
    if (!this.#darwin || this.#policy === policy) return false;
    try {
      this.#o.app.setActivationPolicy(policy);
    } catch (err) {
      this.#o.warn?.(`could not switch to ${policy}: ${String(err)}`);
      return false;
    }
    this.#policy = policy;
    return true;
  }
}
