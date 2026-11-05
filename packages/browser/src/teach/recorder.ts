import {
  type BrowserTeachStepKind,
  classifyTeachField,
  classifyTeachValue,
  PsycheError,
  redactTeachText,
  type TeachFieldFacts,
  type TeachSensitiveReason,
  teachRole,
  teachText,
  teachUrl,
  type Unsubscribe,
} from "@psyche/protocol";
import type { CdpTarget } from "../cdp/page.ts";
import { teachCaptureScript } from "./capture-script.ts";

/**
 * The owner's demonstration recorder (teach by showing, browser phase; design doc §3).
 *
 * Owner-initiated only: this class is constructed by the desktop app's main process in answer to
 * the owner pressing Record in the pane. Nothing in the agent's reach constructs it: it is not a
 * tool, not a Gateway method and not a bridge command, and the bridge's CDP allowlist refuses
 * `Runtime.addBinding`.
 *
 * It listens through CDP in the built-in browser only:
 * - `Runtime.addBinding` scoped to a named isolated world, plus `Page.addScriptToEvaluateOnNewDocument`
 *   in that world, so the page script (`teachCaptureScript`) survives navigations and the page's
 *   own scripts cannot reach it or forge a step;
 * - `Page.frameNavigated` for the top frame, to record where the owner went.
 *
 * It reads no cookies, storage, headers or response bodies. Typed values of sensitive fields never
 * arrive (the page script does not read them) and are dropped again here if one slips through. The
 * typed value of any other field is kept as `sample`, in this object's memory only, so the review
 * screen can offer "keep this value" or "make it an input"; `stop()` hands the steps over once and
 * forgets them.
 */

export interface RecordedStep {
  id: string;
  kind: BrowserTeachStepKind;
  /** Epoch ms. */
  at: number;
  /** navigate: origin and path. */
  url?: string;
  role?: string;
  /** Accessible name: untrusted page text, one line. */
  name?: string;
  selector?: string;
  key?: string;
  /** The field is sensitive: no value was or will be kept. */
  sensitive?: boolean;
  reason?: TeachSensitiveReason;
  /** The example the owner typed; never set on a sensitive step; held in memory only. */
  sample?: string;
}

export interface TeachRecording {
  id: string;
  startedAt: number;
  endedAt: number;
  steps: RecordedStep[];
  /** Why recording ended when the owner did not press Stop. */
  endedBy: "stop" | "limit" | "interrupted";
  /** Page changes the page made by itself (script, redirect, refresh) that got no step. */
  skippedNavigations: number;
}

export interface TeachRecorderOptions {
  cdp: CdpTarget;
  /** The address the tab is on when recording starts: the first step. */
  startUrl: string;
  now?: () => number;
  newId?: () => string;
  /** Most steps one recording holds (default 200, the protocol's cap). */
  maxSteps?: number;
  /** A navigation within this long after a click or Enter is that click's effect, not a step. */
  causedNavMs?: number;
  /** Called after every change with the number of steps so far. */
  onChange?: (steps: number) => void;
  /** Called once when recording ends by itself (step cap, or the page's debugger went away). */
  onEnded?: (why: "limit" | "interrupted") => void;
}

const KINDS = new Set<string>(["click", "type", "select", "press"]);
const SENSITIVE_REASONS = new Set<string>([
  "password",
  "payment",
  "one_time_code",
  "identity",
  "secret",
]);
const MAX_PAYLOAD = 4096;

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

function factsOf(v: unknown): TeachFieldFacts {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  const out: TeachFieldFacts = {};
  for (const k of [
    "tag",
    "type",
    "autocomplete",
    "name",
    "id",
    "label",
    "placeholder",
    "inputmode",
  ] as const) {
    const s = str(o[k], 200);
    if (s !== undefined) out[k] = s;
  }
  if (o.wasPassword === true) out.wasPassword = true;
  return out;
}

export class TeachRecorder {
  readonly id: string;
  /** Unguessable per recording: see `teachCaptureScript`. */
  readonly binding: string;
  readonly world: string;
  #o: TeachRecorderOptions;
  #now: () => number;
  #steps: RecordedStep[] = [];
  #n = 0;
  #state: "idle" | "recording" | "ended" = "idle";
  #startedAt = 0;
  #off: Unsubscribe | undefined;
  #scriptId: string | undefined;
  #mainFrameId: string | undefined;
  /** Execution contexts of our world that belong to the top frame. */
  #contexts = new Set<number>();
  #lastActionAt = Number.NEGATIVE_INFINITY;
  /**
   * The owner pressed Back, Forward or Reload in the pane, and the host really navigated: the
   * first top-frame navigation after that is theirs, if it lands on `url`.
   */
  #ownerNav: { until: number; url: string } | undefined;
  #skippedNavigations = 0;
  #tearingDown: Promise<unknown> | undefined;
  #lastUrl = "";
  #endedBy: TeachRecording["endedBy"] = "stop";

  constructor(options: TeachRecorderOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.id = options.newId?.() ?? `teach_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const salt = crypto.randomUUID().replace(/-/g, "");
    this.binding = `psycheTeach_${salt.slice(0, 16)}`;
    this.world = `psyche-teach-${salt.slice(16)}`;
  }

  get state(): "idle" | "recording" | "ended" {
    return this.#state;
  }

  get stepCount(): number {
    return this.#steps.length;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new PsycheError("conflict", "recording already started");
    this.#state = "recording";
    this.#startedAt = this.#now();
    const first = teachUrl(this.#o.startUrl);
    if (first !== "") {
      this.#lastUrl = first;
      this.#add({ kind: "navigate", url: first });
    }
    this.#off = this.#o.cdp.on((method, params) => this.#event(method, params));
    try {
      await this.#o.cdp.send("Page.enable");
      const tree = await this.#o.cdp.send<{ frameTree?: { frame?: { id?: string } } }>(
        "Page.getFrameTree",
      );
      const top = tree?.frameTree?.frame?.id;
      if (typeof top === "string") this.#setMain(top);
      await this.#o.cdp.send("Runtime.enable");
      await this.#o.cdp.send("Runtime.addBinding", {
        name: this.binding,
        executionContextName: this.world,
      });
      const added = await this.#o.cdp.send<{ identifier?: string }>(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: teachCaptureScript(this.binding), worldName: this.world, runImmediately: true },
      );
      this.#scriptId = added?.identifier;
    } catch (err) {
      await this.#teardown();
      this.#state = "ended";
      throw err;
    }
  }

  /** Ends recording and hands over what was recorded. The recorder forgets it. */
  async stop(): Promise<TeachRecording> {
    if (this.#state === "idle") throw new PsycheError("conflict", "recording has not started");
    if (this.#state === "recording") {
      this.#state = "ended";
      await this.#teardown();
    }
    // A teardown started by the step limit may still be running.
    await this.#tearingDown;
    return this.#take();
  }

  /** Ends recording and drops everything. */
  async cancel(): Promise<void> {
    if (this.#state === "recording") {
      this.#state = "ended";
      await this.#teardown();
    }
    this.#steps = [];
  }

  /**
   * The owner used the pane's own Back, Forward or Reload (an event of the app, not of the page)
   * and the host really navigated, to `expectedUrl` (the history entry, or the current address
   * for Reload). The first top-frame navigation within a few seconds after it is the owner's, and
   * gets a step only if it lands on that address. The window is used up by that first navigation
   * whatever it is (a Reload, a page redirect, a script), and by a navigation within the document,
   * so a page cannot ride it: a `location.assign` on load comes second, or lands elsewhere. A
   * navigation the page starts by itself never gets a step.
   */
  ownerNavigation(expectedUrl: string): void {
    const url = teachUrl(expectedUrl);
    this.#ownerNav = url === "" ? undefined : { until: this.#now() + 3000, url };
  }

  /** The page's debugger went away: what was recorded stays available to `stop()`. */
  interrupted(): void {
    if (this.#state !== "recording") return;
    this.#state = "ended";
    this.#endedBy = "interrupted";
    this.#off?.();
    this.#off = undefined;
    this.#o.onEnded?.("interrupted");
  }

  #take(): TeachRecording {
    const steps = this.#steps;
    this.#steps = [];
    return {
      id: this.id,
      startedAt: this.#startedAt,
      endedAt: this.#now(),
      steps,
      endedBy: this.#endedBy,
      skippedNavigations: this.#skippedNavigations,
    };
  }

  async #teardown(): Promise<void> {
    this.#off?.();
    this.#off = undefined;
    const cdp = this.#o.cdp;
    // Best effort: the tab may be gone, and what was recorded must still reach the review.
    const quiet = async (send: () => Promise<unknown>) => {
      try {
        await send();
      } catch {
        // Nothing to undo in a page that is gone.
      }
    };
    for (const contextId of this.#contexts) {
      await quiet(() =>
        cdp.send("Runtime.evaluate", {
          contextId,
          expression: "window.__psycheTeachStop && window.__psycheTeachStop()",
          returnByValue: true,
        }),
      );
    }
    this.#contexts.clear();
    const scriptId = this.#scriptId;
    if (scriptId !== undefined)
      await quiet(() =>
        cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }),
      );
    await quiet(() => cdp.send("Runtime.removeBinding", { name: this.binding }));
    // Put the domains back as found: the host starts a recording only on a tab the bridge has
    // enabled nothing on, and refuses the bridge's commands for the tab until this resolves.
    await quiet(() => cdp.send("Runtime.disable"));
    await quiet(() => cdp.send("Page.disable"));
  }

  #event(method: string, params: unknown): void {
    if (this.#state !== "recording") return;
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "Runtime.executionContextCreated") {
      const ctx = p.context as
        | { id?: number; name?: string; auxData?: { frameId?: string; isDefault?: boolean } }
        | undefined;
      if (ctx?.name === this.world && typeof ctx.id === "number") {
        // Only the top frame's world counts; a child frame's contexts are never trusted.
        const frameId = ctx.auxData?.frameId;
        if (frameId !== undefined && frameId === this.#mainFrameId) this.#contexts.add(ctx.id);
        else if (this.#mainFrameId === undefined && frameId !== undefined)
          this.#pending.set(ctx.id, frameId);
      }
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      const id = p.executionContextId;
      if (typeof id === "number") {
        this.#contexts.delete(id);
        this.#pending.delete(id);
      }
      return;
    }
    if (method === "Runtime.executionContextsCleared") {
      this.#contexts.clear();
      this.#pending.clear();
      return;
    }
    if (method === "Page.navigatedWithinDocument") {
      // A same-document navigation (pushState, a hash) of the top frame uses up the owner's window.
      if (p.frameId === undefined || p.frameId === this.#mainFrameId) this.#ownerNav = undefined;
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = p.frame as { id?: string; parentId?: string; url?: string } | undefined;
      if (frame === undefined || frame.parentId !== undefined) return;
      if (typeof frame.id === "string") this.#setMain(frame.id);
      this.#navigated(typeof frame.url === "string" ? frame.url : "");
      return;
    }
    if (method === "Runtime.bindingCalled") {
      if (p.name !== this.binding) return;
      const ctx = p.executionContextId;
      if (typeof ctx !== "number" || !this.#contexts.has(ctx)) return;
      if (typeof p.payload === "string") this.#payload(p.payload);
    }
  }

  /** Contexts seen before the main frame's id was known. */
  #pending = new Map<number, string>();

  #setMain(frameId: string): void {
    this.#mainFrameId = frameId;
    for (const [id, f] of this.#pending) if (f === frameId) this.#contexts.add(id);
    this.#pending.clear();
  }

  /** The recorder is told the top frame at start so contexts created early are matched. */
  setMainFrame(frameId: string): void {
    this.#setMain(frameId);
  }

  #navigated(url: string): void {
    const clean = teachUrl(url);
    // The owner's window is used up by the first top-frame navigation, whatever it is.
    const window = this.#ownerNav;
    this.#ownerNav = undefined;
    if (clean === "" || clean === this.#lastUrl) return;
    this.#lastUrl = clean;
    const now = this.#now();
    // The effect of a click or Enter is not a step of its own.
    if (now - this.#lastActionAt <= (this.#o.causedNavMs ?? 4000)) return;
    // Only a navigation the owner made with the pane's own controls, landing where the host sent it.
    if (window !== undefined && now <= window.until && clean === window.url) {
      this.#add({ kind: "navigate", url: clean });
      return;
    }
    this.#skippedNavigations += 1;
  }

  #payload(raw: string): void {
    if (raw.length > MAX_PAYLOAD) return;
    let v: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      v = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = v.k;
    if (typeof kind !== "string" || !KINDS.has(kind)) return;
    const step: Omit<RecordedStep, "id" | "at"> = { kind: kind as BrowserTeachStepKind };
    const role = str(v.role, 64);
    const name = str(v.name, 400);
    const selector = str(v.selector, 600);
    if (role !== undefined) step.role = teachRole(role);
    if (name !== undefined && name !== "") step.name = redactTeachText(teachText(name, 120));
    if (selector !== undefined && selector !== "")
      step.selector = redactTeachText(teachText(selector, 300));
    if (kind === "press") {
      const key = str(v.key, 40);
      if (key !== "Enter") return;
      step.key = key;
    }
    if (kind === "type" || kind === "select") {
      // The field decides again, on this side, whether it is sensitive.
      const claimed = str(v.reason, 20);
      const why: TeachSensitiveReason | null =
        classifyTeachField(factsOf(v.f)) ??
        (SENSITIVE_REASONS.has(claimed ?? "") ? (claimed as TeachSensitiveReason) : null) ??
        (v.sensitive === true ? "secret" : null);
      const value = str(v.value, 500);
      const valueWhy = value === undefined ? null : classifyTeachValue(value);
      if (why !== null || valueWhy !== null) {
        step.sensitive = true;
        step.reason = why ?? valueWhy ?? "secret";
      } else if (value !== undefined) {
        step.sample = value;
      }
      // Editing the same field again replaces the earlier step instead of adding one.
      const prev = this.#steps[this.#steps.length - 1];
      if (
        prev !== undefined &&
        prev.kind === kind &&
        prev.selector === step.selector &&
        prev.name === step.name
      ) {
        prev.at = this.#now();
        if (step.sensitive === true) {
          prev.sensitive = true;
          prev.reason = step.reason as TeachSensitiveReason;
          delete prev.sample;
        } else {
          delete prev.sensitive;
          delete prev.reason;
          if (step.sample !== undefined) prev.sample = step.sample;
          else delete prev.sample;
        }
        this.#o.onChange?.(this.#steps.length);
        return;
      }
    }
    this.#lastActionAt = this.#now();
    this.#add(step);
  }

  #add(step: Omit<RecordedStep, "id" | "at">): void {
    if (this.#steps.length >= (this.#o.maxSteps ?? 200)) {
      if (this.#state === "recording") {
        this.#state = "ended";
        this.#endedBy = "limit";
        // The tab is freed (`onEnded`) only after the binding is gone.
        this.#tearingDown = this.#teardown().finally(() => this.#o.onEnded?.("limit"));
      }
      return;
    }
    this.#n += 1;
    this.#steps.push({ id: `s${this.#n}`, at: this.#now(), ...step });
    this.#o.onChange?.(this.#steps.length);
  }
}
