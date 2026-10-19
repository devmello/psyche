import type {
  BrowserDriver,
  CallOptions,
  DriverControlState,
  DriverDownload,
  DriverEvent,
  DriverProfile,
  DriverSession,
  DriverTab,
  NavigateResult,
  PageSnapshot,
  SnapshotRef,
  Unsubscribe,
  WaitCondition,
} from "@psyche/protocol";
import { captureModelVisible } from "../capture.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface FixtureElement {
  role: string;
  name: string;
  value?: string;
  states?: string[];
  /** Clicking navigates here (relative or absolute URL). */
  href?: string;
  /** Clicking downloads this file. */
  download?: { filename: string; mime: string; size: number };
}

export interface FixturePage {
  title: string;
  text: string;
  elements?: FixtureElement[];
  status?: number;
}

/** A fixture website: absolute URL → page. Unknown URLs render a 404 page. */
export interface SiteFixture {
  pages: Record<string, FixturePage>;
}

interface TabState {
  tab: DriverTab;
  history: string[];
  index: number;
  values: Map<string, string>;
}

const MASK = "•••";

/** `states` containing `protected` (AX secure text field) or `password` marks a password field. */
function isSecureField(e: FixtureElement): boolean {
  return e.states?.some((s) => s === "protected" || s === "password") === true;
}

const BLOCKED_SCHEMES = ["about:", "chrome:", "file:", "javascript:", "data:"];

/**
 * Fixture-backed browser driver. Pages come from `site(fixture)`; refs are `ref_<n>` in element
 * order and stable for a URL. Typing stores values per tab; nothing touches the network.
 */
export class FakeBrowserDriver implements BrowserDriver {
  readonly actions: { tabId: string; action: string; ref?: string; text?: string }[] = [];
  #ids: IdGenerator;
  #pages: Record<string, FixturePage> = {};
  #sessions = new Map<string, DriverSession>();
  #tabs = new Map<string, TabState>();
  #listeners = new Set<(e: DriverEvent) => void>();
  #profiles: DriverProfile[] = [{ id: "default", name: "Default", kind: "embedded" }];

  constructor(options: { ids?: IdGenerator; site?: SiteFixture } = {}) {
    this.#ids = options.ids ?? createIdGenerator();
    if (options.site !== undefined) this.site(options.site);
  }

  static site(fixture: SiteFixture): FakeBrowserDriver {
    return new FakeBrowserDriver({ site: fixture });
  }

  site(fixture: SiteFixture): this {
    this.#pages = { ...this.#pages, ...structuredClone(fixture.pages) };
    return this;
  }

  #emit(e: DriverEvent): void {
    for (const l of this.#listeners) l(e);
  }

  #state(tabId: string): TabState {
    const s = this.#tabs.get(tabId);
    if (s === undefined) return fail("not_found", `tab ${tabId} not found`);
    return s;
  }

  #agentAction(tabId: string): TabState {
    const s = this.#state(tabId);
    const session = this.#sessions.get(s.tab.sessionId);
    if (session !== undefined && session.controlState !== "agent") {
      return fail("conflict", `agent input is paused (control: ${session.controlState})`);
    }
    return s;
  }

  #page(url: string): FixturePage {
    return this.#pages[url] ?? { title: "Not found", text: `404 ${url}`, status: 404 };
  }

  #elements(s: TabState): (FixtureElement & { ref: string })[] {
    return (this.#page(s.tab.url).elements ?? []).map((e, i) => ({ ...e, ref: `ref_${i + 1}` }));
  }

  #element(s: TabState, ref: string): FixtureElement & { ref: string } {
    const el = this.#elements(s).find((e) => e.ref === ref);
    if (el === undefined) return fail("not_found", `${ref} not in snapshot`);
    return el;
  }

  #go(s: TabState, url: string, push: boolean): NavigateResult {
    const lower = url.toLowerCase();
    if (BLOCKED_SCHEMES.some((p) => lower.startsWith(p))) {
      return fail("forbidden", `scheme blocked: ${url}`);
    }
    if (push) {
      s.history = s.history.slice(0, s.index + 1);
      s.history.push(url);
      s.index = s.history.length - 1;
    }
    const page = this.#page(url);
    s.tab.url = url;
    s.tab.title = page.title;
    s.values.clear();
    this.#emit({ type: "navigated", tabId: s.tab.id, url });
    const result: NavigateResult = { url, title: page.title };
    if (page.status !== undefined) result.status = page.status;
    return result;
  }

  async listProfiles(): Promise<DriverProfile[]> {
    return structuredClone(this.#profiles);
  }

  async openSession(
    options: { profileId?: string; taskId?: string; partition?: "profile" | "clean" } = {},
  ): Promise<DriverSession> {
    const session: DriverSession = {
      id: this.#ids.next("bsess"),
      profileId: options.profileId ?? "default",
      partition: options.partition ?? "profile",
      controlState: "agent",
    };
    if (options.taskId !== undefined) session.taskId = options.taskId;
    this.#sessions.set(session.id, session);
    return { ...session };
  }

  async closeSession(sessionId: string): Promise<void> {
    for (const [id, s] of this.#tabs) if (s.tab.sessionId === sessionId) this.#tabs.delete(id);
    this.#sessions.delete(sessionId);
  }

  async listTabs(sessionId: string): Promise<DriverTab[]> {
    return [...this.#tabs.values()]
      .filter((s) => s.tab.sessionId === sessionId)
      .map((s) => ({ ...s.tab }));
  }

  async openTab(sessionId: string, url?: string): Promise<DriverTab> {
    if (!this.#sessions.has(sessionId)) return fail("not_found", `session ${sessionId} not found`);
    for (const s of this.#tabs.values()) if (s.tab.sessionId === sessionId) s.tab.active = false;
    const tab: DriverTab = {
      id: this.#ids.next("tab"),
      sessionId,
      url: "about:blank",
      title: "",
      active: true,
    };
    const state: TabState = { tab, history: [], index: -1, values: new Map() };
    this.#tabs.set(tab.id, state);
    this.#emit({ type: "tab_opened", tabId: tab.id });
    if (url !== undefined) this.#go(state, url, true);
    return { ...tab };
  }

  async focusTab(tabId: string): Promise<void> {
    const s = this.#state(tabId);
    for (const o of this.#tabs.values())
      if (o.tab.sessionId === s.tab.sessionId) o.tab.active = o === s;
  }

  async closeTab(tabId: string): Promise<void> {
    this.#state(tabId);
    this.#tabs.delete(tabId);
    this.#emit({ type: "tab_closed", tabId });
  }

  async navigate(tabId: string, url: string, options: CallOptions = {}): Promise<NavigateResult> {
    if (options.signal?.aborted === true) return fail("cancelled", "navigation aborted");
    const s = this.#agentAction(tabId);
    this.actions.push({ tabId, action: "navigate", text: url });
    return this.#go(s, url, true);
  }

  async back(tabId: string): Promise<NavigateResult> {
    const s = this.#agentAction(tabId);
    if (s.index > 0) s.index -= 1;
    return this.#go(s, s.history[s.index] ?? s.tab.url, false);
  }

  async forward(tabId: string): Promise<NavigateResult> {
    const s = this.#agentAction(tabId);
    if (s.index < s.history.length - 1) s.index += 1;
    return this.#go(s, s.history[s.index] ?? s.tab.url, false);
  }

  async snapshot(tabId: string, options: { maxRefs?: number } = {}): Promise<PageSnapshot> {
    const s = this.#state(tabId);
    const all: SnapshotRef[] = this.#elements(s).map((e) => {
      const ref: SnapshotRef = { ref: e.ref, role: e.role, name: e.name };
      const value = s.values.get(e.ref) ?? e.value;
      // Password fields never expose their value (security §4.7).
      if (value !== undefined) ref.value = isSecureField(e) && value !== "" ? MASK : value;
      if (e.states !== undefined) ref.states = [...e.states];
      return ref;
    });
    const max = options.maxRefs ?? all.length;
    const snap: PageSnapshot = { url: s.tab.url, title: s.tab.title, refs: all.slice(0, max) };
    if (all.length > max) snap.truncated = true;
    if (all.length === 0) snap.sparse = true;
    captureModelVisible("tool_result", snap, { where: "FakeBrowserDriver.snapshot" });
    return snap;
  }

  async find(tabId: string, query: string): Promise<SnapshotRef[]> {
    const q = query.toLowerCase();
    const snap = await this.snapshot(tabId);
    return snap.refs.filter((r) =>
      `${r.role} ${r.name} ${r.value ?? ""}`.toLowerCase().includes(q),
    );
  }

  async click(tabId: string, ref: string): Promise<void> {
    const s = this.#agentAction(tabId);
    const el = this.#element(s, ref);
    this.actions.push({ tabId, action: "click", ref });
    if (el.href !== undefined) this.#go(s, new URL(el.href, s.tab.url).toString(), true);
  }

  async type(
    tabId: string,
    ref: string,
    text: string,
    options: { submit?: boolean } = {},
  ): Promise<void> {
    const s = this.#agentAction(tabId);
    this.#element(s, ref);
    s.values.set(ref, (s.values.get(ref) ?? "") + text);
    this.actions.push({
      tabId,
      action: options.submit === true ? "type_submit" : "type",
      ref,
      text,
    });
  }

  async select(tabId: string, ref: string, values: string[]): Promise<void> {
    const s = this.#agentAction(tabId);
    this.#element(s, ref);
    s.values.set(ref, values.join(","));
    this.actions.push({ tabId, action: "select", ref, text: values.join(",") });
  }

  async scroll(
    tabId: string,
    options: { ref?: string; direction: "up" | "down" | "left" | "right" },
  ): Promise<void> {
    this.#agentAction(tabId);
    const entry: FakeBrowserDriver["actions"][number] = {
      tabId,
      action: `scroll_${options.direction}`,
    };
    if (options.ref !== undefined) entry.ref = options.ref;
    this.actions.push(entry);
  }

  async readText(
    tabId: string,
    options: { maxChars?: number } = {},
  ): Promise<{ text: string; truncated: boolean }> {
    const s = this.#state(tabId);
    const text = this.#page(s.tab.url).text;
    const max = options.maxChars ?? text.length;
    const result = { text: text.slice(0, max), truncated: text.length > max };
    captureModelVisible("tool_result", result, { where: "FakeBrowserDriver.readText" });
    return result;
  }

  async screenshot(tabId: string): Promise<{ mime: "image/png"; data: Uint8Array }> {
    this.#state(tabId);
    // 8-byte PNG signature: enough for type sniffing in tests.
    return {
      mime: "image/png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
  }

  async download(
    tabId: string,
    source: { ref: string } | { url: string },
  ): Promise<DriverDownload> {
    const s = this.#agentAction(tabId);
    const file =
      "ref" in source
        ? this.#element(s, source.ref).download
        : {
            filename: source.url.split("/").pop() || "download",
            mime: "application/octet-stream",
            size: 0,
          };
    if (file === undefined) return fail("invalid_params", "element is not a download");
    const download: DriverDownload = { id: this.#ids.next("dl"), ...file, quarantined: true };
    this.#emit({ type: "download", tabId, download });
    return download;
  }

  async wait(tabId: string, condition: WaitCondition, options: CallOptions = {}): Promise<void> {
    if (options.signal?.aborted === true) return fail("cancelled", "wait aborted");
    const s = this.#state(tabId);
    if (condition.kind === "text" && !this.#page(s.tab.url).text.includes(condition.text)) {
      return fail("timeout", `text not found: ${condition.text}`);
    }
    if (condition.kind === "ref") this.#element(s, condition.ref);
  }

  async getControlState(sessionId: string): Promise<DriverControlState> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return fail("not_found", `session ${sessionId} not found`);
    return session.controlState;
  }

  async setControlState(sessionId: string, state: DriverControlState): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return fail("not_found", `session ${sessionId} not found`);
    session.controlState = state;
    this.#emit({ type: "control_state", sessionId, state });
  }

  onEvent(listener: (event: DriverEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
