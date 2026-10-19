import {
  type CallOptions,
  type NavigateResult,
  PsycheError,
  type ResolvedSecret,
  type Unsubscribe,
  type WaitCondition,
} from "@psyche/protocol";
import { canonicalizeUrl, tryOrigin } from "../origin/canonical.ts";
import type { Hop, OriginPolicy } from "../origin/policy.ts";
import { buildSnapshot, extractText, type FrameAx } from "../snapshot/builder.ts";
import { type RefEntry, RefRegistry } from "../snapshot/refs.ts";
import type {
  ActionTarget,
  BrowserSnapshot,
  ConsoleEntry,
  DialogInfo,
  DriverEventEx,
  ElementMeta,
  NetworkEntry,
  PointerAction,
  RecordingSink,
  SnapshotOptions,
} from "../types.ts";
import { keyEvents } from "./keys.ts";
import type {
  AXNode,
  CaptureSnapshotResult,
  FrameTree,
  LayoutMetrics,
  NavigationEntry,
} from "./types.ts";

/**
 * A CDP endpoint for one tab: the desktop bridge (`bridge.cdp.send`) or a Playwright
 * `CDPSession`. Both drivers run every page operation through `PageController` on top of this,
 * so refs, boxes, pruning and action semantics are identical by construction (feature I2).
 */
export interface CdpTarget {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** CDP events of this tab. */
  on(listener: (method: string, params: unknown) => void): Unsubscribe;
}

/** Fixed helper run in the `psyche` isolated world: sets a native `<select>`. Reads nothing back. */
export const SELECT_HELPER = `/* psyche:select */ function (values) {
  if (this.tagName !== "SELECT") return { ok: false, reason: "not_select" };
  const want = new Set(values);
  const matched = [];
  for (const o of this.options) {
    const hit = want.has(o.value) || want.has(o.label) || want.has(o.text.trim());
    if (this.multiple) o.selected = hit;
    else if (hit && matched.length === 0) this.value = o.value;
    if (hit) matched.push(o.value);
  }
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: matched.length > 0, matched: matched.length };
}`;

/** Fixed helper: starts a download of `url` from the page's context (cookies apply). */
export const DOWNLOAD_HELPER = `/* psyche:download */ function (url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.style.display = "none";
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  return { ok: true };
}`;

const WORLD_NAME = "psyche";
const MAX_LOG = 500;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const NETWORK_IDLE_MS = 500;
const POLL_MS = 100;

export interface PageControllerOptions {
  tabId: string;
  target: CdpTarget;
  policy: () => OriginPolicy;
  /** Throws `conflict` while the user holds the tab (Take control) or the agent is paused. */
  assertAgent: () => void;
  /** True while the user is in control: navigations they make join the read-only set. */
  userInControl: () => boolean;
  emit: (event: DriverEventEx) => void;
  /** CredentialBroker.redact: post-fill hygiene for snapshots and text (security §4.7). */
  redact?: (text: string) => string;
  /** Answers a JavaScript dialog; defaults to `Page.handleJavaScriptDialog`. */
  dialogHandler?: (accept: boolean, promptText?: string) => Promise<void>;
  recording?: RecordingSink;
  /** Bridge method allowlists drop `Network.enable` in some setups; navigation still works. */
  enableNetwork?: boolean;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new PsycheError("cancelled", "aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new PsycheError("cancelled", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** A payment card number in free text (security §6: no card entry in the browser). */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

export class PageController {
  readonly tabId: string;
  readonly refs = new RefRegistry();
  #t: CdpTarget;
  #o: PageControllerOptions;
  #off: Unsubscribe;
  #url = "about:blank";
  #title = "";
  #mainFrameId: string | undefined;
  #loaderId = "";
  #loaded = false;
  #loadWaiters = new Set<Waiter>();
  #inflight = new Set<string>();
  #lastNetworkActivity = 0;
  #mainStatus: number | undefined;
  #navError: PsycheError | undefined;
  #blocked: { url: string; reason: string; message: string } | undefined;
  #dialog: DialogInfo | undefined;
  #console: ConsoleEntry[] = [];
  #network = new Map<string, NetworkEntry>();
  #worlds = new Map<string, number>();
  #secureActive = false;
  #needsSnapshot = false;
  #recording = false;
  #closed = false;
  #stoppedUrl: string | undefined;

  constructor(options: PageControllerOptions) {
    this.tabId = options.tabId;
    this.#t = options.target;
    this.#o = options;
    this.#off = this.#t.on((m, p) => this.#onEvent(m, p as Record<string, unknown>));
  }

  /** Enable the domains this controller listens to and learn the current frame. */
  async init(): Promise<void> {
    const enables = [this.#t.send("Page.enable"), this.#t.send("Runtime.enable")];
    if (this.#o.enableNetwork !== false) enables.push(this.#t.send("Network.enable"));
    await Promise.all(enables);
    const tree = await this.#t.send<{ frameTree: FrameTree }>("Page.getFrameTree");
    this.#mainFrameId = tree.frameTree.frame.id;
    this.#url = tree.frameTree.frame.url;
    this.#loaderId = tree.frameTree.frame.loaderId;
    this.refs.setDocument(`${this.#loaderId}|${this.#url}`);
    this.#loaded = true;
    // A tab the desktop loaded before we attached is judged like any committed navigation.
    this.#checkCommit(this.#url);
    if (this.#o.recording !== undefined) await this.startRecording();
  }

  dispose(): void {
    this.#closed = true;
    this.#off();
    const err = new PsycheError("not_found", `tab ${this.tabId} closed`);
    for (const w of this.#loadWaiters) w.reject(err);
    this.#loadWaiters.clear();
    if (this.#recording) void this.#o.recording?.close();
  }

  get url(): string {
    return this.#url;
  }
  get title(): string {
    return this.#title;
  }
  get origin(): string | undefined {
    return tryOrigin(this.#url);
  }
  get secureFieldActive(): boolean {
    return this.#secureActive;
  }
  get dialog(): DialogInfo | undefined {
    return this.#dialog;
  }
  get blocked(): { url: string; reason: string } | undefined {
    return this.#blocked;
  }
  get consoleMessages(): ConsoleEntry[] {
    return [...this.#console];
  }
  get networkLog(): NetworkEntry[] {
    return [...this.#network.values()];
  }

  /** After Take control: refs must be re-read before the next by-ref action. */
  requireSnapshot(): void {
    this.#needsSnapshot = true;
    this.refs.invalidate();
  }

  // --- events ------------------------------------------------------------------------------

  #onEvent(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "Page.frameNavigated": {
        const frame = p.frame as FrameTree["frame"];
        if (frame.parentId !== undefined) {
          this.#worlds.delete(frame.id);
          return;
        }
        this.#mainFrameId = frame.id;
        this.#url = frame.url;
        this.#loaderId = frame.loaderId;
        this.#worlds.clear();
        this.#dialog = undefined;
        this.#setSecure(false);
        this.refs.setDocument(`${this.#loaderId}|${this.#url}`);
        this.#checkCommit(frame.url);
        this.#o.emit({ type: "navigated", tabId: this.tabId, url: frame.url });
        return;
      }
      case "Page.navigatedWithinDocument": {
        if (p.frameId === this.#mainFrameId && typeof p.url === "string") {
          this.#url = p.url;
          this.#checkCommit(p.url);
        }
        return;
      }
      case "Page.frameStartedLoading":
        if (p.frameId === this.#mainFrameId) this.#loaded = false;
        return;
      case "Page.loadEventFired": {
        this.#loaded = true;
        for (const w of this.#loadWaiters) w.resolve();
        this.#loadWaiters.clear();
        return;
      }
      case "Network.requestWillBeSent":
        this.#onRequest(p);
        return;
      case "Network.responseReceived": {
        const id = String(p.requestId);
        const r = p.response as { status?: number } | undefined;
        const entry = this.#network.get(id);
        if (entry !== undefined && r?.status !== undefined) entry.status = r.status;
        if (p.type === "Document" && p.frameId === this.#mainFrameId) this.#mainStatus = r?.status;
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const id = String(p.requestId);
        this.#inflight.delete(id);
        this.#lastNetworkActivity = Date.now();
        if (method === "Network.loadingFailed") {
          const entry = this.#network.get(id);
          if (entry !== undefined) entry.failed = true;
        }
        return;
      }
      case "Page.javascriptDialogOpening": {
        const type = String(p.type) as DialogInfo["type"];
        const info: DialogInfo = { type, message: String(p.message ?? "") };
        if (typeof p.defaultPrompt === "string") info.defaultPrompt = p.defaultPrompt;
        this.#dialog = info;
        this.#o.emit({ type: "dialog", tabId: this.tabId, message: info.message });
        return;
      }
      case "Page.javascriptDialogClosed":
        this.#dialog = undefined;
        return;
      case "Runtime.consoleAPICalled": {
        if (!this.#o.policy().devPreview) return;
        const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
        const text = args
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? "")))
          .join(" ");
        this.#console.push({ level: String(p.type), text: text.slice(0, 2000), at: Date.now() });
        if (this.#console.length > MAX_LOG) this.#console.shift();
        return;
      }
      case "Page.screencastFrame":
        void this.#onFrame(p);
        return;
      default:
        return;
    }
  }

  #onRequest(p: Record<string, unknown>): void {
    const id = String(p.requestId);
    const req = p.request as { url: string; method: string };
    this.#inflight.add(id);
    this.#lastNetworkActivity = Date.now();
    if (this.#o.policy().devPreview) {
      this.#network.set(id, {
        requestId: id,
        url: req.url.slice(0, 2048),
        method: req.method,
        type: String(p.type ?? ""),
        at: Date.now(),
      });
      if (this.#network.size > MAX_LOG) {
        const first = this.#network.keys().next().value;
        if (first !== undefined) this.#network.delete(first);
      }
    }
    // Every top-level document request is a hop: the initial load, link clicks, form posts,
    // script-driven location changes and each redirect (security §6: "on every hop").
    if (p.type !== "Document" || p.frameId !== this.#mainFrameId) return;
    const hop: Hop = p.redirectResponse !== undefined ? "redirect" : "initial";
    if (this.#o.userInControl()) {
      this.#ownerNavigated(req.url);
      return;
    }
    const v = this.#o.policy().evaluateSync(req.url, hop);
    if (v.action === "allow") return;
    void this.#t.send("Page.stopLoading").catch(() => undefined);
    // A stopped GET can be replayed once the origin is approved; a POST is never replayed.
    this.#stoppedUrl =
      v.action === "approve" && (req.method === "GET" || req.method === "HEAD")
        ? req.url
        : undefined;
    if (v.action === "approve") {
      this.#navError = new PsycheError(
        "approval_required",
        `${hop === "redirect" ? "redirect to" : "navigation to"} new origin ${v.url.origin} needs approval`,
        { details: { kind: "new_origin", origin: v.url.origin, url: v.url.href, hop } },
      );
      this.#o.emit({
        type: "approval_needed",
        tabId: this.tabId,
        url: v.url.href,
        origin: v.url.origin,
        hop,
      });
    } else {
      this.#navError = new PsycheError("policy_denied", v.message, {
        details: { reason: v.reason, url: req.url.slice(0, 2048), hop },
      });
      this.#o.emit({ type: "blocked", tabId: this.tabId, url: req.url, reason: v.reason });
    }
    for (const w of this.#loadWaiters) w.reject(this.#navError);
    this.#loadWaiters.clear();
  }

  /** The owner navigated while holding the tab: that origin joins the task's read-only set. */
  #ownerNavigated(url: string): void {
    const origin = tryOrigin(url);
    if (origin === undefined) return;
    try {
      this.#o.policy().grant(origin, "read");
    } catch {
      // Not a grantable origin (loopback outside dev preview, etc.): the commit check gates it.
    }
  }

  /**
   * After the tool layer widened the policy (an approved `new_origin`): lift a content block
   * whose origin is now allowed, and replay a stopped GET navigation. Returns what it did.
   */
  async retryBlocked(): Promise<"unblocked" | "renavigated" | "unchanged"> {
    const stopped = this.#stoppedUrl;
    if (stopped !== undefined && this.#o.policy().evaluateSync(stopped).action === "allow") {
      this.#stoppedUrl = undefined;
      await this.#runNavigation(async () => {
        await this.#t.send("Page.navigate", { url: stopped });
      }, {});
      return "renavigated";
    }
    if (this.#blocked !== undefined) {
      this.#checkCommit(this.#url);
      if (this.#blocked === undefined) return "unblocked";
    }
    return "unchanged";
  }

  /** A committed main-frame URL the policy does not allow gates every page read and action. */
  #checkCommit(url: string): void {
    if (url === "about:blank" || url === "") {
      this.#blocked = undefined;
      return;
    }
    if (this.#o.userInControl()) this.#ownerNavigated(url);
    const v = this.#o.policy().evaluateSync(url, "commit");
    if (v.action === "allow") {
      this.#blocked = undefined;
      return;
    }
    const reason = v.action === "approve" ? "new_origin" : v.reason;
    const message =
      v.action === "approve" ? `${v.url.origin} is not in this task's origin set` : v.message;
    this.#blocked = { url, reason, message };
    this.#o.emit({ type: "blocked", tabId: this.tabId, url, reason });
  }

  async #onFrame(p: Record<string, unknown>): Promise<void> {
    const sessionId = p.sessionId;
    await this.#t.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    const sink = this.#o.recording;
    // Frames while a secure field is active are dropped, as screenshots are (security §4.7).
    if (sink === undefined || this.#secureActive || this.#blocked !== undefined) return;
    if (typeof p.data !== "string") return;
    await sink.frame({
      tabId: this.tabId,
      data: Buffer.from(p.data, "base64"),
      at: Date.now(),
      url: this.#url,
    });
  }

  #setSecure(active: boolean): void {
    if (this.#secureActive === active) return;
    this.#secureActive = active;
    this.#o.emit({ type: "secure_field", tabId: this.tabId, active });
  }

  // --- guards ------------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new PsycheError("not_found", `tab ${this.tabId} is closed`);
  }

  #assertReadable(): void {
    this.#assertOpen();
    if (this.#blocked !== undefined) {
      throw new PsycheError(
        this.#blocked.reason === "new_origin" ? "approval_required" : "policy_denied",
        `page content withheld: ${this.#blocked.message}`,
        {
          details: {
            reason: this.#blocked.reason,
            url: this.#blocked.url,
            ...(this.#blocked.reason === "new_origin"
              ? { kind: "new_origin", origin: tryOrigin(this.#blocked.url) }
              : {}),
          },
        },
      );
    }
  }

  #assertActionable(): void {
    this.#assertReadable();
    this.#o.assertAgent();
    if (this.#dialog !== undefined) {
      throw new PsycheError("conflict", `a ${this.#dialog.type} dialog is open; answer it first`, {
        details: { reason: "dialog_open" },
      });
    }
  }

  #resolveRef(ref: string): RefEntry {
    if (this.#needsSnapshot) {
      throw new PsycheError("conflict", "the user had control; take a new snapshot first", {
        details: { reason: "stale_after_take_control" },
      });
    }
    const e = this.refs.resolve(ref);
    const top = this.origin;
    if (e.meta.frameOrigin !== top) {
      throw new PsycheError("policy_denied", `${ref} is inside a cross-origin frame`, {
        details: { reason: "cross_origin_frame" },
      });
    }
    return e;
  }

  // --- navigation --------------------------------------------------------------------------

  #waitLoad(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      };
      const timer = setTimeout(
        () => w.reject(new PsycheError("timeout", `load did not finish in ${timeoutMs} ms`)),
        timeoutMs,
      );
      const onAbort = () => w.reject(new PsycheError("cancelled", "navigation aborted"));
      const cleanup = () => {
        clearTimeout(timer);
        this.#loadWaiters.delete(w);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#loadWaiters.add(w);
    });
  }

  async #checkInitial(url: string): Promise<string> {
    const v = await this.#o.policy().evaluate(url, "initial");
    if (v.action === "deny") {
      throw new PsycheError("policy_denied", v.message, { details: { reason: v.reason, url } });
    }
    if (v.action === "approve") {
      throw new PsycheError("approval_required", `navigation to new origin ${v.url.origin}`, {
        details: { kind: "new_origin", origin: v.url.origin, url: v.url.href, hop: "initial" },
      });
    }
    return v.url.href;
  }

  async #runNavigation(
    start: () => Promise<void>,
    options: CallOptions & { timeoutMs?: number },
  ): Promise<NavigateResult> {
    this.#navError = undefined;
    this.#mainStatus = undefined;
    const loaded = this.#waitLoad(options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS, options.signal);
    loaded.catch(() => undefined);
    await start();
    await loaded;
    if (this.#navError !== undefined) throw this.#navError;
    this.#assertReadable();
    await this.#refreshTitle();
    const result: NavigateResult = { url: this.#url, title: this.#title };
    if (this.#mainStatus !== undefined) result.status = this.#mainStatus;
    return result;
  }

  async #refreshTitle(): Promise<void> {
    const h = await this.#t
      .send<{ currentIndex: number; entries: NavigationEntry[] }>("Page.getNavigationHistory")
      .catch(() => undefined);
    const e = h?.entries[h.currentIndex];
    if (e !== undefined) this.#title = e.title;
  }

  async navigate(
    url: string,
    options: CallOptions & { timeoutMs?: number } = {},
  ): Promise<NavigateResult> {
    this.#assertOpen();
    this.#o.assertAgent();
    const href = await this.#checkInitial(url);
    return this.#runNavigation(async () => {
      const r = await this.#t.send<{ errorText?: string }>("Page.navigate", { url: href });
      if (r.errorText !== undefined && r.errorText !== "" && this.#navError === undefined) {
        throw new PsycheError("unavailable", `navigation failed: ${r.errorText}`, {
          details: { url: href },
        });
      }
    }, options);
  }

  async history(delta: -1 | 1): Promise<NavigateResult> {
    this.#assertOpen();
    this.#o.assertAgent();
    const h = await this.#t.send<{ currentIndex: number; entries: NavigationEntry[] }>(
      "Page.getNavigationHistory",
    );
    const entry = h.entries[h.currentIndex + delta];
    if (entry === undefined) return { url: this.#url, title: this.#title };
    await this.#checkInitial(entry.url);
    return this.#runNavigation(
      () => this.#t.send("Page.navigateToHistoryEntry", { entryId: entry.id }).then(() => {}),
      {},
    );
  }

  async reload(): Promise<NavigateResult> {
    this.#assertReadable();
    this.#o.assertAgent();
    return this.#runNavigation(() => this.#t.send("Page.reload", {}).then(() => {}), {});
  }

  // --- reading -----------------------------------------------------------------------------

  async #frames(): Promise<FrameAx[]> {
    const tree = await this.#t.send<{ frameTree: FrameTree }>("Page.getFrameTree");
    const top = this.origin;
    const out: FrameAx[] = [];
    const walk = async (t: FrameTree) => {
      for (const child of t.childFrames ?? []) {
        // Only same-origin frames; unrelated cross-origin iframes stay hidden (security §6).
        if (tryOrigin(child.frame.url) === top && top !== undefined) {
          const r = await this.#t
            .send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId: child.frame.id })
            .catch(() => undefined);
          if (r !== undefined)
            out.push({ frameId: child.frame.id, url: child.frame.url, ax: r.nodes });
          await walk(child);
        }
      }
    };
    await walk(tree.frameTree);
    return out;
  }

  async snapshot(options: SnapshotOptions = {}): Promise<BrowserSnapshot> {
    this.#assertReadable();
    const t0 = performance.now();
    const [ax, dom, lm, frames] = await Promise.all([
      this.#t.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}),
      this.#t.send<CaptureSnapshotResult>("DOMSnapshot.captureSnapshot", { computedStyles: [] }),
      this.#t.send<LayoutMetrics & { layoutViewport?: { clientWidth: number } }>(
        "Page.getLayoutMetrics",
      ),
      this.#frames(),
    ]);
    await this.#refreshTitle();
    const fetchMs = performance.now() - t0;
    const css = lm.cssLayoutViewport ??
      lm.cssVisualViewport ?? { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 };
    const device = lm.layoutViewport?.clientWidth;
    const dpr = device !== undefined && css.clientWidth > 0 ? device / css.clientWidth : 1;
    const input: Parameters<typeof buildSnapshot>[0] = {
      url: this.#url,
      title: this.#title,
      ax: ax.nodes,
      frames,
      dom,
      dpr,
      viewport: css,
      refs: this.refs,
      options,
      fetchMs,
    };
    if (this.#o.redact !== undefined) input.redact = this.#o.redact;
    const snap = buildSnapshot(input);
    this.#needsSnapshot = false;
    this.#setSecure(snap.secureFieldActive);
    if (snap.captcha === true) this.#o.emit({ type: "captcha", tabId: this.tabId, url: this.#url });
    return snap;
  }

  async readText(
    options: { maxChars?: number } = {},
  ): Promise<{ text: string; truncated: boolean }> {
    this.#assertReadable();
    const [ax, frames] = await Promise.all([
      this.#t.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}),
      this.#frames(),
    ]);
    const opts: Parameters<typeof extractText>[1] = { frames };
    if (options.maxChars !== undefined) opts.maxChars = options.maxChars;
    if (this.#o.redact !== undefined) opts.redact = this.#o.redact;
    return extractText(ax.nodes, opts);
  }

  async describe(ref: string): Promise<ElementMeta> {
    this.#assertReadable();
    return { ...this.refs.resolve(ref).meta };
  }

  async screenshot(): Promise<{ mime: "image/png"; data: Uint8Array }> {
    this.#assertReadable();
    // Re-check: a secure field focused or holding a value suppresses screenshots (§4.7).
    await this.snapshot({ maxChars: 1000, maxRefs: 1 });
    if (this.#secureActive) {
      throw new PsycheError(
        "policy_denied",
        "a password or other secure field is active; screenshots are suppressed",
        { details: { reason: "secure_field" } },
      );
    }
    const r = await this.#t.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return { mime: "image/png", data: new Uint8Array(Buffer.from(r.data, "base64")) };
  }

  // --- actions -----------------------------------------------------------------------------

  async #center(ref: string): Promise<{ x: number; y: number }> {
    const e = this.#resolveRef(ref);
    await this.#t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: e.backendNodeId });
    const { quads } = await this.#t.send<{ quads: number[][] }>("DOM.getContentQuads", {
      backendNodeId: e.backendNodeId,
    });
    const q = quads[0];
    if (q === undefined || q.length < 8) {
      throw new PsycheError("conflict", `${ref} has no layout box (hidden or detached)`, {
        details: { reason: "no_layout" },
      });
    }
    const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
    const y = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
    return { x, y };
  }

  async #point(target: ActionTarget): Promise<{ x: number; y: number }> {
    if ("ref" in target) return this.#center(target.ref);
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new PsycheError("invalid_params", "coordinates must be finite numbers");
    }
    return { x: target.x, y: target.y };
  }

  #mouse(params: Record<string, unknown>): Promise<unknown> {
    return this.#t.send("Input.dispatchMouseEvent", params);
  }

  async pointer(target: ActionTarget, action: PointerAction): Promise<void> {
    this.#assertActionable();
    const { x, y } = await this.#point(target);
    this.#o.assertAgent();
    await this.#mouse({ type: "mouseMoved", x, y });
    if (action === "hover") return;
    const button = action === "right_click" ? "right" : "left";
    const clicks = action === "double_click" ? 2 : 1;
    for (let c = 1; c <= clicks; c++) {
      await this.#mouse({ type: "mousePressed", x, y, button, clickCount: c });
      await this.#mouse({ type: "mouseReleased", x, y, button, clickCount: c });
    }
  }

  async #key(chord: string): Promise<void> {
    for (const e of keyEvents(chord)) await this.#t.send("Input.dispatchKeyEvent", { ...e });
  }

  async press(keys: string, options: { ref?: string } = {}): Promise<void> {
    this.#assertActionable();
    if (options.ref !== undefined) {
      const e = this.#resolveRef(options.ref);
      await this.#t.send("DOM.focus", { backendNodeId: e.backendNodeId });
    }
    for (const chord of keys.split(/\s+/).filter((k) => k !== "")) {
      this.#o.assertAgent();
      await this.#key(chord);
    }
  }

  async type(
    ref: string,
    text: string,
    options: { submit?: boolean; clear?: boolean } = {},
  ): Promise<void> {
    this.#assertActionable();
    const e = this.#resolveRef(ref);
    if (e.meta.secure) {
      throw new PsycheError(
        "policy_denied",
        `${ref} is a secure field: fill it from the vault with approval, or let the owner type`,
        { details: { reason: "secure_field" } },
      );
    }
    if (/\{\{cred:/.test(text)) {
      throw new PsycheError("policy_denied", "credential placeholders go through fill_credential", {
        details: { reason: "placeholder" },
      });
    }
    if (looksLikeCardNumber(text)) {
      throw new PsycheError("policy_denied", "card numbers are never typed in the browser", {
        details: { reason: "card_number" },
      });
    }
    await this.#t.send("DOM.focus", { backendNodeId: e.backendNodeId });
    if (options.clear === true) {
      await this.#key("Meta+a");
      await this.#key("Backspace");
    }
    this.#o.assertAgent();
    if (text !== "") await this.#t.send("Input.insertText", { text });
    if (options.submit === true) await this.#key("Enter");
  }

  async #isolatedCall<T>(
    backendNodeId: number,
    fn: string,
    args: unknown[],
  ): Promise<T | undefined> {
    const frameId = this.#mainFrameId;
    if (frameId === undefined) throw new PsycheError("unavailable", "no main frame yet");
    let ctx = this.#worlds.get(frameId);
    if (ctx === undefined) {
      const w = await this.#t.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
        frameId,
        worldName: WORLD_NAME,
        grantUniveralAccess: false,
      });
      ctx = w.executionContextId;
      this.#worlds.set(frameId, ctx);
    }
    const { object } = await this.#t.send<{ object: { objectId?: string } }>("DOM.resolveNode", {
      backendNodeId,
      executionContextId: ctx,
    });
    if (object.objectId === undefined) throw new PsycheError("conflict", "element not resolvable");
    const r = await this.#t.send<{ result: { value?: T } }>("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    return r.result.value;
  }

  async select(ref: string, values: string[]): Promise<void> {
    this.#assertActionable();
    const e = this.#resolveRef(ref);
    const r = await this.#isolatedCall<{ ok: boolean; reason?: string }>(
      e.backendNodeId,
      SELECT_HELPER,
      [values],
    );
    if (r?.ok !== true) {
      throw new PsycheError(
        "invalid_params",
        r?.reason === "not_select"
          ? `${ref} is not a native <select>; click it and then the option instead`
          : `none of ${JSON.stringify(values)} is an option of ${ref}`,
        { details: { reason: r?.reason ?? "no_match" } },
      );
    }
  }

  async scroll(options: {
    ref?: string;
    direction: "up" | "down" | "left" | "right";
    amount?: number;
  }): Promise<void> {
    this.#assertActionable();
    let x = 400;
    let y = 300;
    if (options.ref !== undefined) ({ x, y } = await this.#center(options.ref));
    else {
      const lm = await this.#t.send<LayoutMetrics>("Page.getLayoutMetrics");
      const vp = lm.cssLayoutViewport;
      if (vp !== undefined) {
        x = vp.clientWidth / 2;
        y = vp.clientHeight / 2;
      }
    }
    const amount = options.amount ?? 600;
    const d = options.direction;
    await this.#mouse({
      type: "mouseWheel",
      x,
      y,
      deltaX: d === "left" ? -amount : d === "right" ? amount : 0,
      deltaY: d === "up" ? -amount : d === "down" ? amount : 0,
    });
  }

  async scrollTo(ref: string): Promise<void> {
    this.#assertActionable();
    const e = this.#resolveRef(ref);
    await this.#t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: e.backendNodeId });
  }

  async drag(from: ActionTarget, to: ActionTarget): Promise<void> {
    this.#assertActionable();
    const a = await this.#point(from);
    const b = await this.#point(to);
    await this.#mouse({ type: "mouseMoved", x: a.x, y: a.y });
    await this.#mouse({ type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      this.#o.assertAgent();
      await this.#mouse({
        type: "mouseMoved",
        x: a.x + ((b.x - a.x) * i) / 5,
        y: a.y + ((b.y - a.y) * i) / 5,
        button: "left",
      });
    }
    await this.#mouse({ type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
  }

  async upload(ref: string, paths: string[]): Promise<void> {
    this.#assertActionable();
    const e = this.#resolveRef(ref);
    if (e.meta.inputType !== "file") {
      throw new PsycheError("invalid_params", `${ref} is not a file input`);
    }
    await this.#t.send("DOM.setFileInputFiles", { files: paths, backendNodeId: e.backendNodeId });
  }

  /** Starts a download of `url` from the page (fixed isolated-world helper; cookies apply). */
  async startDownload(url: string): Promise<void> {
    this.#assertActionable();
    const href = await this.#checkInitial(url);
    const { root } = await this.#t.send<{ root: { backendNodeId: number } }>("DOM.getDocument", {
      depth: 0,
    });
    await this.#isolatedCall(root.backendNodeId, DOWNLOAD_HELPER, [href]);
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    this.#assertOpen();
    this.#o.assertAgent();
    if (this.#dialog === undefined) throw new PsycheError("not_found", "no dialog is open");
    if (this.#o.dialogHandler !== undefined) await this.#o.dialogHandler(accept, promptText);
    else {
      const params: Record<string, unknown> = { accept };
      if (promptText !== undefined) params.promptText = promptText;
      await this.#t.send("Page.handleJavaScriptDialog", params);
    }
    this.#dialog = undefined;
  }

  /** Dialog closed outside the controller (Playwright answers through its own Dialog object). */
  dialogClosed(): void {
    this.#dialog = undefined;
  }

  async fillSecret(ref: string, secret: ResolvedSecret, origin: string): Promise<void> {
    this.#assertActionable();
    const want = canonicalizeUrl(origin).origin;
    if (this.origin !== want) {
      throw new PsycheError("policy_denied", "the page's origin is not the credential's origin", {
        details: { reason: "origin_mismatch", expected: want, actual: this.origin ?? null },
      });
    }
    const e = this.#resolveRef(ref);
    await this.#t.send("DOM.focus", { backendNodeId: e.backendNodeId });
    this.#o.assertAgent();
    await secret.use((value) => this.#t.send("Input.insertText", { text: value }));
    if (e.meta.secure) this.#setSecure(true);
  }

  // --- waiting -----------------------------------------------------------------------------

  async wait(
    condition: WaitCondition,
    options: CallOptions & { timeoutMs?: number } = {},
  ): Promise<void> {
    this.#assertOpen();
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const until = async (check: () => Promise<boolean> | boolean, what: string) => {
      for (;;) {
        if (await check()) return;
        if (Date.now() >= deadline) {
          throw new PsycheError("timeout", `${what} not reached within ${timeoutMs} ms`);
        }
        await sleep(POLL_MS, options.signal);
      }
    };
    switch (condition.kind) {
      case "timeout":
        await sleep(Math.min(Math.max(0, condition.ms), 60_000), options.signal);
        return;
      case "load":
        if (this.#loaded) return;
        await this.#waitLoad(timeoutMs, options.signal);
        if (this.#navError !== undefined) throw this.#navError;
        return;
      case "network_idle":
        await until(
          () =>
            this.#inflight.size === 0 && Date.now() - this.#lastNetworkActivity >= NETWORK_IDLE_MS,
          "network idle",
        );
        return;
      case "text":
        await until(
          async () => (await this.readText({ maxChars: 200_000 })).text.includes(condition.text),
          `text ${JSON.stringify(condition.text)}`,
        );
        return;
      case "ref":
        await until(async () => {
          const e = this.refs.resolve(condition.ref);
          const r = await this.#t
            .send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: e.backendNodeId })
            .catch(() => ({ quads: [] }));
          return r.quads.length > 0;
        }, `${condition.ref} visible`);
        return;
    }
  }

  // --- recording ---------------------------------------------------------------------------

  async startRecording(): Promise<void> {
    if (this.#recording || this.#o.recording === undefined) return;
    await this.#t.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 2,
    });
    this.#recording = true;
  }

  async stopRecording(): Promise<void> {
    if (!this.#recording) return;
    this.#recording = false;
    await this.#t.send("Page.stopScreencast").catch(() => undefined);
    await this.#o.recording?.close();
  }
}
