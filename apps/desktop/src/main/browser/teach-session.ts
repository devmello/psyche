import {
  type RecordedStep,
  type TeachKeptStore,
  TeachRecorder,
  type TeachRecording,
} from "@psyche/browser/teach";
import { type BrowserTeachStep, PsycheError } from "@psyche/protocol";

/**
 * Teach by showing in the built-in browser (design doc §2, §5): the one place a recording is
 * started, held and ended. Owner-initiated only: its methods are reached from the owner's
 * renderer through IPC, never from the Gateway or the bridge, so the agent has no way to call
 * them, and while a tab is recorded every bridge CDP command for it is refused (`recording()`).
 *
 * One recording at a time, in one tab. The steps live in this object's memory from Record until
 * Stop hands them to the review screen; after Stop nothing is held here. Nothing is written to
 * disk except by `keep()` (the owner's explicit choice), and then only the reviewed steps.
 */

/** What the host gives the session for one tab. */
export interface TeachTabPort {
  id: string;
  url(): string;
  /** CDP over the tab's debugger, from the host itself (not through the bridge policy). */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The tab's CDP events, before they are filtered for the Gateway. Returns an unsubscribe. */
  subscribe(listener: (method: string, params: unknown) => void): () => void;
  /** Sticky Take control: the owner holds the tab, so the agent's input is refused. */
  hold(on: boolean): void;
}

export interface TeachState {
  tabId: string;
  /** Steps recorded so far. */
  steps: number;
  /** Set when recording ended without Stop: review what was recorded. */
  ended?: "limit" | "interrupted";
}

export interface TeachReview {
  id: string;
  endedBy: TeachRecording["endedBy"];
  steps: RecordedStep[];
  /** Page changes the page made by itself, which got no step. */
  skippedNavigations: number;
}

interface Current {
  tab: TeachTabPort;
  rec: TeachRecorder;
  steps: number;
  ended?: "limit" | "interrupted";
  /** Stop is tearing the recorder down: its channel stays hidden until that resolves. */
  stopping?: boolean;
}

export interface TeachSessionOptions {
  /** Called when the state changes (the pane shows the indicator from it). */
  onChange: () => void;
  kept: TeachKeptStore;
  newRecorder?: (o: ConstructorParameters<typeof TeachRecorder>[0]) => TeachRecorder;
}

export class TeachSession {
  #o: TeachSessionOptions;
  #cur: Current | undefined;

  constructor(options: TeachSessionOptions) {
    this.#o = options;
  }

  get state(): TeachState | null {
    const c = this.#cur;
    if (c === undefined) return null;
    return {
      tabId: c.tab.id,
      steps: c.steps,
      ...(c.ended === undefined ? {} : { ended: c.ended }),
    };
  }

  /** The tab is being recorded: bridge commands for it are refused. */
  recording(tabId: string): boolean {
    return this.#cur?.tab.id === tabId;
  }

  /**
   * Events of the recorder's own channel never go to the Gateway: they carry what the owner
   * typed. True for the binding call and for the announcement of its world.
   */
  hides(tabId: string, method: string, params: unknown): boolean {
    const c = this.#cur;
    if (c === undefined || c.tab.id !== tabId) return false;
    const p = (params ?? {}) as { name?: unknown; context?: { name?: unknown } };
    if (method === "Runtime.bindingCalled") return p.name === c.rec.binding;
    if (method === "Runtime.executionContextCreated") return p.context?.name === c.rec.world;
    return false;
  }

  async start(tab: TeachTabPort): Promise<void> {
    if (this.#cur !== undefined)
      throw new PsycheError("conflict", "a recording is already running");
    let url = tab.url();
    if (!/^https?:\/\//.test(url)) url = "";
    const create = this.#o.newRecorder ?? ((o) => new TeachRecorder(o));
    const rec = create({
      cdp: {
        send: (method, params) => tab.send(method, params) as Promise<never>,
        on: (listener) => tab.subscribe(listener),
      },
      startUrl: url,
      onChange: (n) => {
        if (this.#cur?.rec === rec) {
          this.#cur.steps = n;
          this.#o.onChange();
        }
      },
      onEnded: (why) => {
        if (this.#cur?.rec === rec) {
          this.#cur.ended = why;
          this.#cur.tab.hold(false);
          this.#o.onChange();
        }
      },
    });
    const cur: Current = { tab, rec, steps: 0 };
    this.#cur = cur;
    tab.hold(true);
    try {
      await rec.start();
    } catch (err) {
      this.#cur = undefined;
      tab.hold(false);
      this.#o.onChange();
      throw new PsycheError("unavailable", "could not start recording this tab", {
        details: { reason: err instanceof Error ? err.message : String(err) },
      });
    }
    cur.steps = rec.stepCount;
    this.#o.onChange();
  }

  /**
   * Ends the recording and hands the steps to the review screen; nothing is kept here. The
   * recording stays "current" until the teardown (`Runtime.removeBinding` and the rest) has
   * resolved, so the bridge stays refused for the tab and the recorder's channel stays hidden
   * from the Gateway for the whole of it.
   */
  async stop(): Promise<TeachReview> {
    const cur = this.#cur;
    if (cur === undefined || cur.stopping === true)
      throw new PsycheError("conflict", "nothing is being recorded");
    cur.stopping = true;
    let rec: TeachRecording;
    try {
      rec = await cur.rec.stop();
    } finally {
      if (this.#cur === cur) this.#cur = undefined;
      cur.tab.hold(false);
      this.#o.onChange();
    }
    return {
      id: rec.id,
      endedBy: rec.endedBy,
      steps: rec.steps,
      skippedNavigations: rec.skippedNavigations,
    };
  }

  /** Ends the recording and drops it (same rule: current until the teardown resolved). */
  async cancel(): Promise<void> {
    const cur = this.#cur;
    if (cur === undefined || cur.stopping === true) return;
    cur.stopping = true;
    try {
      await cur.rec.cancel();
    } finally {
      if (this.#cur === cur) this.#cur = undefined;
      cur.tab.hold(false);
      this.#o.onChange();
    }
  }

  /** The owner used the pane's Back, Forward or Reload on this tab. */
  ownerNavigated(tabId: string, expectedUrl: string): void {
    const cur = this.#cur;
    if (cur !== undefined && cur.tab.id === tabId) cur.rec.ownerNavigation(expectedUrl);
  }

  /** The tab's debugger went away or the tab closed: keep what was recorded for review. */
  interrupted(tabId: string): void {
    const cur = this.#cur;
    if (cur === undefined || cur.tab.id !== tabId) return;
    cur.rec.interrupted();
    cur.ended ??= "interrupted";
    this.#o.onChange();
  }

  // ── kept recordings (the owner's explicit choice) ────────────────────────────────────────

  /** `encrypted`, or `unavailable` when the OS keychain cannot protect a kept recording. */
  storage(): { encrypted: boolean } {
    return { encrypted: this.#o.kept.canKeep };
  }

  keep(id: string, title: string, steps: readonly BrowserTeachStep[]) {
    return this.#o.kept.keep(id, title, steps);
  }
  listKept() {
    return this.#o.kept.list();
  }
  async openKept(id: string) {
    const rec = await this.#o.kept.get(id);
    if (rec === undefined) throw new PsycheError("not_found", "no such kept recording");
    return rec;
  }
  deleteKept(id: string) {
    return this.#o.kept.delete(id);
  }
}
