import {
  type CallOptions,
  type DriverControlState,
  type DriverDownload,
  type DriverEvent,
  type DriverProfile,
  type DriverSession,
  type DriverTab,
  type NavigateResult,
  type PageSnapshot,
  type PermissionBroker,
  PsycheError,
  type ResolvedSecret,
  type SnapshotRef,
  type Unsubscribe,
  type WaitCondition,
} from "@psyche/protocol";
import { type CdpTarget, PageController } from "../cdp/page.ts";
import { headAndHash, type LibraryWriter } from "../downloads/library.ts";
import { sniff } from "../downloads/sniff.ts";
import { PartitionChooser, type TabPartition } from "../origin/partition.ts";
import { OriginPolicy } from "../origin/policy.ts";
import type {
  ActionTarget,
  BrowserDriverEx,
  BrowserSnapshot,
  ConsoleEntry,
  DialogInfo,
  DriverEventEx,
  DriverTabEx,
  ElementMeta,
  NetworkEntry,
  OpenSessionOptions,
  PointerAction,
  RecordingSink,
  SnapshotOptions,
} from "../types.ts";

/**
 * Session, tab, control-state, download and event bookkeeping shared by the CDP-bridge and
 * Playwright drivers. Subclasses provide tab creation (a `CdpTarget` per tab) and lifecycle;
 * every page operation runs through `PageController`.
 */

export interface DriverDeps {
  library: LibraryWriter;
  /** Receipts for downloads (security §15.2). Optional so tests can run without one. */
  broker?: PermissionBroker;
  /** CredentialBroker.redact, for post-fill hygiene in snapshots and text. */
  redact?: (text: string) => string;
  downloadTimeoutMs?: number;
}

export interface SessionState {
  session: DriverSession;
  policy: OriginPolicy;
  /** Which partition each new tab gets (feature I15). */
  partitions: PartitionChooser;
  recording?: RecordingSink;
  tabs: Set<string>;
  /** Tabs held by the user (Take control); the session is `user` while any is. */
  userTabs: Set<string>;
}

export interface TabState {
  tab: DriverTab;
  page: PageController;
  session: SessionState;
  partition: TabPartition;
}

interface DownloadWaiter {
  resolve: (d: DriverDownload) => void;
  reject: (e: unknown) => void;
}

let idSeq = 0;
export function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}`;
}

export abstract class DriverBase implements BrowserDriverEx {
  protected readonly deps: DriverDeps;
  protected readonly sessions = new Map<string, SessionState>();
  protected readonly tabs = new Map<string, TabState>();
  #listeners = new Set<(e: DriverEvent) => void>();
  #exListeners = new Set<(e: DriverEventEx) => void>();
  #downloadWaiters = new Map<string, DownloadWaiter[]>();

  constructor(deps: DriverDeps) {
    this.deps = deps;
  }

  abstract listProfiles(): Promise<DriverProfile[]>;
  /**
   * Create a tab (blank, or at `url` after the policy check) in `partition` and return its id
   * and target.
   */
  protected abstract createTab(
    s: SessionState,
    url: string | undefined,
    partition: TabPartition,
  ): Promise<{ id: string; target: CdpTarget; url: string }>;
  protected abstract destroyTab(t: TabState): Promise<void>;
  protected async onSessionOpened(_s: SessionState, _o: OpenSessionOptions): Promise<void> {}
  protected async onSessionClosed(_s: SessionState): Promise<void> {}
  protected dialogHandlerFor(
    _tabId: string,
  ): ((accept: boolean, promptText?: string) => Promise<void>) | undefined {
    return undefined;
  }

  // --- events ------------------------------------------------------------------------------

  protected emit(e: DriverEventEx): void {
    for (const l of [...this.#exListeners]) l(e);
    if (
      e.type === "navigated" ||
      e.type === "tab_opened" ||
      e.type === "tab_closed" ||
      e.type === "dialog" ||
      e.type === "download" ||
      e.type === "control_state"
    ) {
      for (const l of [...this.#listeners]) l(e);
    }
  }

  onEvent(listener: (event: DriverEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onEventEx(listener: (event: DriverEventEx) => void): Unsubscribe {
    this.#exListeners.add(listener);
    return () => this.#exListeners.delete(listener);
  }

  // --- sessions ----------------------------------------------------------------------------

  protected sessionState(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (s === undefined) throw new PsycheError("not_found", `session ${sessionId} not found`);
    return s;
  }

  protected tabState(tabId: string): TabState {
    const t = this.tabs.get(tabId);
    if (t === undefined) throw new PsycheError("not_found", `tab ${tabId} not found`);
    return t;
  }

  async openSession(options: OpenSessionOptions = {}): Promise<DriverSession> {
    // Logged-out by default (security §6): the persistent profile is used only when the task
    // says so, or per tab for origins the owner signed into (`auto`).
    const partitions = new PartitionChooser({
      mode: options.partition ?? "auto",
      ...(options.signedInOrigins === undefined
        ? {}
        : { signedInOrigins: options.signedInOrigins }),
    });
    const session: DriverSession = {
      id: newId("bsess"),
      profileId: options.profileId ?? "default",
      partition: partitions.defaultPartition,
      controlState: "agent",
    };
    if (options.taskId !== undefined) session.taskId = options.taskId;
    const policy =
      options.policy instanceof OriginPolicy ? options.policy : new OriginPolicy(options.policy);
    const s: SessionState = {
      session,
      policy,
      partitions,
      tabs: new Set(),
      userTabs: new Set(),
    };
    if (options.recording !== undefined) s.recording = options.recording;
    this.sessions.set(session.id, s);
    await this.onSessionOpened(s, options);
    return { ...session };
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessionState(sessionId);
    for (const id of [...s.tabs]) await this.closeTab(id).catch(() => undefined);
    await this.onSessionClosed(s);
    this.sessions.delete(sessionId);
  }

  policy(sessionId: string): OriginPolicy {
    return this.sessionState(sessionId).policy;
  }

  async getControlState(sessionId: string): Promise<DriverControlState> {
    return this.sessionState(sessionId).session.controlState;
  }

  async setControlState(sessionId: string, state: DriverControlState): Promise<void> {
    this.#setSessionControl(this.sessionState(sessionId), state);
  }

  /** The desktop reported a per-tab control change (bridge.control.changed). */
  protected tabControlChanged(tabId: string, state: DriverControlState): void {
    const t = this.tabs.get(tabId);
    if (t === undefined) return;
    const s = t.session;
    if (state === "user") s.userTabs.add(tabId);
    else s.userTabs.delete(tabId);
    const next: DriverControlState =
      s.userTabs.size > 0 ? "user" : state === "paused" ? "paused" : "agent";
    this.#setSessionControl(s, next);
  }

  #setSessionControl(s: SessionState, state: DriverControlState): void {
    const prev = s.session.controlState;
    if (prev === state) return;
    s.session.controlState = state;
    if (state !== "user") s.userTabs.clear();
    // Back from the user: every ref is re-read before the agent acts again (security §6).
    if (prev === "user" && state === "agent") {
      for (const id of s.tabs) this.tabs.get(id)?.page.requireSnapshot();
    }
    this.emit({ type: "control_state", sessionId: s.session.id, state });
  }

  protected assertAgent(s: SessionState): void {
    const state = s.session.controlState;
    if (state === "agent") return;
    throw new PsycheError(
      "conflict",
      state === "user"
        ? "the user has taken control of the browser; wait for them to release it"
        : "the agent's browser input is paused",
      { details: { reason: state === "user" ? "user_in_control" : "paused" }, retryable: true },
    );
  }

  // --- tabs --------------------------------------------------------------------------------

  /**
   * Register a tab created by `createTab`, a popup or an adopted page. A popup inherits its
   * opener's partition (the desktop and Playwright open it in the opener's context anyway).
   */
  protected async adoptTab(
    s: SessionState,
    id: string,
    target: CdpTarget,
    url: string,
    opener?: string,
    partition?: TabPartition,
  ): Promise<TabState> {
    const part =
      partition ??
      (opener === undefined ? undefined : this.tabs.get(opener)?.partition) ??
      s.partitions.defaultPartition;
    const options: ConstructorParameters<typeof PageController>[0] = {
      tabId: id,
      target,
      policy: () => s.policy,
      assertAgent: () => this.assertAgent(s),
      userInControl: () => s.session.controlState === "user",
      emit: (e) => this.#onPageEvent(id, e),
    };
    if (this.deps.redact !== undefined) options.redact = this.deps.redact;
    const dh = this.dialogHandlerFor(id);
    if (dh !== undefined) options.dialogHandler = dh;
    if (s.recording !== undefined) options.recording = s.recording;
    const page = new PageController(options);
    for (const other of s.tabs) {
      const o = this.tabs.get(other);
      if (o !== undefined) o.tab.active = false;
    }
    const tab: DriverTab = { id, sessionId: s.session.id, url, title: "", active: true };
    const t: TabState = { tab, page, session: s, partition: part };
    this.tabs.set(id, t);
    s.tabs.add(id);
    await page.init();
    tab.url = page.url;
    this.emit({ type: "tab_opened", tabId: id });
    if (opener !== undefined) this.emit({ type: "popup", tabId: id, openerTabId: opener, url });
    return t;
  }

  /** `DriverTab` plus the partition, from the live page state. */
  #tabInfo(t: TabState): DriverTabEx {
    return { ...t.tab, url: t.page.url, title: t.page.title, partition: t.partition };
  }

  /** The partition a tab runs in (feature I15). */
  tabPartition(tabId: string): TabPartition {
    return this.tabState(tabId).partition;
  }

  protected forgetTab(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (t === undefined) return;
    t.page.dispose();
    t.session.tabs.delete(tabId);
    t.session.userTabs.delete(tabId);
    this.tabs.delete(tabId);
    for (const w of this.#downloadWaiters.get(tabId) ?? []) {
      w.reject(new PsycheError("not_found", `tab ${tabId} closed`));
    }
    this.#downloadWaiters.delete(tabId);
    this.emit({ type: "tab_closed", tabId });
  }

  #onPageEvent(tabId: string, e: DriverEventEx): void {
    const t = this.tabs.get(tabId);
    if (t !== undefined && e.type === "navigated") t.tab.url = e.url;
    this.emit(e);
  }

  async listTabs(sessionId: string): Promise<DriverTabEx[]> {
    const s = this.sessionState(sessionId);
    return [...s.tabs].flatMap((id) => {
      const t = this.tabs.get(id);
      return t === undefined ? [] : [this.#tabInfo(t)];
    });
  }

  async openTab(sessionId: string, url?: string): Promise<DriverTabEx> {
    const s = this.sessionState(sessionId);
    this.assertAgent(s);
    if (url !== undefined) {
      const v = await s.policy.evaluate(url, "initial");
      if (v.action === "deny") {
        throw new PsycheError("policy_denied", v.message, { details: { reason: v.reason, url } });
      }
      if (v.action === "approve") {
        throw new PsycheError("approval_required", `navigation to new origin ${v.url.origin}`, {
          details: { kind: "new_origin", origin: v.url.origin, url: v.url.href, hop: "initial" },
        });
      }
    }
    const choice = s.partitions.choose(url);
    const created = await this.createTab(s, url, choice.partition);
    const t = await this.adoptTab(
      s,
      created.id,
      created.target,
      created.url,
      undefined,
      choice.partition,
    );
    this.emit({ type: "tab_partition", tabId: t.tab.id, ...choice });
    if (url !== undefined && (t.page.url === "about:blank" || t.page.url === "")) {
      await t.page.navigate(url);
    }
    return this.#tabInfo(t);
  }

  async focusTab(tabId: string): Promise<void> {
    const t = this.tabState(tabId);
    for (const id of t.session.tabs) {
      const o = this.tabs.get(id);
      if (o !== undefined) o.tab.active = o === t;
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const t = this.tabState(tabId);
    await this.destroyTab(t);
    this.forgetTab(tabId);
  }

  // --- page operations ---------------------------------------------------------------------

  #page(tabId: string): PageController {
    return this.tabState(tabId).page;
  }

  navigate(tabId: string, url: string, options: CallOptions = {}): Promise<NavigateResult> {
    return this.#page(tabId).navigate(url, options);
  }
  back(tabId: string): Promise<NavigateResult> {
    return this.#page(tabId).history(-1);
  }
  forward(tabId: string): Promise<NavigateResult> {
    return this.#page(tabId).history(1);
  }
  reload(tabId: string): Promise<NavigateResult> {
    return this.#page(tabId).reload();
  }
  snapshot(tabId: string, options?: SnapshotOptions): Promise<BrowserSnapshot> {
    return this.#page(tabId).snapshot(options);
  }

  async find(tabId: string, query: string): Promise<SnapshotRef[]> {
    const snap = await this.#page(tabId).snapshot({ maxRefs: 5000, maxChars: 200_000 });
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== "");
    const scored = snap.refs
      .map((r) => {
        const hay = `${r.role} ${r.name} ${r.value ?? ""}`.toLowerCase();
        const hits = terms.filter((t) => hay.includes(t)).length;
        return { r, hits };
      })
      .filter((x) => x.hits === terms.length && terms.length > 0)
      .sort((a, b) => Number(b.r.interactive) - Number(a.r.interactive));
    return scored.slice(0, 20).map((x) => {
      const out: SnapshotRef = { ref: x.r.ref, role: x.r.role, name: x.r.name };
      if (x.r.value !== undefined) out.value = x.r.value;
      if (x.r.states !== undefined) out.states = x.r.states;
      if (x.r.box !== undefined) out.box = x.r.box;
      return out;
    });
  }

  click(tabId: string, ref: string): Promise<void> {
    return this.#page(tabId).pointer({ ref }, "click");
  }
  pointer(tabId: string, target: ActionTarget, action: PointerAction): Promise<void> {
    return this.#page(tabId).pointer(target, action);
  }
  type(
    tabId: string,
    ref: string,
    text: string,
    options?: { submit?: boolean; clear?: boolean },
  ): Promise<void> {
    return this.#page(tabId).type(ref, text, options);
  }
  select(tabId: string, ref: string, values: string[]): Promise<void> {
    return this.#page(tabId).select(ref, values);
  }
  scroll(
    tabId: string,
    options: { ref?: string; direction: "up" | "down" | "left" | "right"; amount?: number },
  ): Promise<void> {
    return this.#page(tabId).scroll(options);
  }
  scrollTo(tabId: string, ref: string): Promise<void> {
    return this.#page(tabId).scrollTo(ref);
  }
  press(tabId: string, keys: string, options?: { ref?: string }): Promise<void> {
    return this.#page(tabId).press(keys, options);
  }
  drag(tabId: string, from: ActionTarget, to: ActionTarget): Promise<void> {
    return this.#page(tabId).drag(from, to);
  }
  upload(tabId: string, ref: string, paths: string[]): Promise<void> {
    return this.#page(tabId).upload(ref, paths);
  }
  readText(tabId: string, options?: { maxChars?: number }) {
    return this.#page(tabId).readText(options);
  }
  screenshot(tabId: string) {
    return this.#page(tabId).screenshot();
  }
  handleDialog(tabId: string, accept: boolean, promptText?: string): Promise<void> {
    return this.#page(tabId).handleDialog(accept, promptText);
  }
  pendingDialog(tabId: string): DialogInfo | undefined {
    return this.#page(tabId).dialog;
  }
  describe(tabId: string, ref: string): Promise<ElementMeta> {
    return this.#page(tabId).describe(ref);
  }
  peek(tabId: string, ref: string): ElementMeta | undefined {
    return this.tabs.get(tabId)?.page.peek(ref);
  }
  tabOrigin(tabId: string): string | undefined {
    return this.tabs.get(tabId)?.page.origin;
  }
  fillSecret(tabId: string, ref: string, secret: ResolvedSecret, origin: string): Promise<void> {
    return this.#page(tabId).fillSecret(ref, secret, origin);
  }
  /** After an approved `new_origin`: unblock content or replay a stopped navigation. */
  retryBlocked(tabId: string): Promise<"unblocked" | "renavigated" | "unchanged"> {
    return this.#page(tabId).retryBlocked();
  }
  consoleMessages(tabId: string): ConsoleEntry[] {
    this.#assertDevPreview(tabId);
    return this.#page(tabId).consoleMessages;
  }
  networkLog(tabId: string): NetworkEntry[] {
    this.#assertDevPreview(tabId);
    return this.#page(tabId).networkLog;
  }
  #assertDevPreview(tabId: string): void {
    if (!this.tabState(tabId).session.policy.devPreview) {
      throw new PsycheError(
        "policy_denied",
        "console and network logs are for dev-preview tasks only",
      );
    }
  }

  wait(
    tabId: string,
    condition: WaitCondition,
    options?: CallOptions & { timeoutMs?: number },
  ): Promise<void> {
    return this.#page(tabId).wait(condition, options);
  }

  // --- downloads ---------------------------------------------------------------------------

  #awaitDownload(tabId: string, timeoutMs: number): Promise<DriverDownload> {
    return new Promise((resolve, reject) => {
      const list = this.#downloadWaiters.get(tabId) ?? [];
      const timer = setTimeout(() => {
        const l = this.#downloadWaiters.get(tabId) ?? [];
        this.#downloadWaiters.set(
          tabId,
          l.filter((w) => w !== waiter),
        );
        reject(new PsycheError("timeout", `no download started within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter: DownloadWaiter = {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      list.push(waiter);
      this.#downloadWaiters.set(tabId, list);
    });
  }

  async download(
    tabId: string,
    source: { ref: string } | { url: string },
  ): Promise<DriverDownload> {
    const t = this.tabState(tabId);
    const wait = this.#awaitDownload(tabId, this.deps.downloadTimeoutMs ?? 30_000);
    wait.catch(() => undefined);
    if ("ref" in source) await t.page.pointer({ ref: source.ref }, "click");
    else await t.page.startDownload(source.url);
    return wait;
  }

  /**
   * A finished download landed at `path` (desktop quarantine or Playwright save path): sniff,
   * import into the Library quarantine, emit, receipt. Never opened.
   */
  protected async downloadCompleted(
    tabId: string,
    file: { path: string; filename: string; mime: string | null; url: string },
  ): Promise<DriverDownload | undefined> {
    const t = this.tabs.get(tabId);
    if (t === undefined) return undefined;
    const { head } = await headAndHash(file.path);
    const sniffed = sniff(head, file.filename, file.mime);
    const q: Parameters<LibraryWriter["importDownload"]>[0] = {
      path: file.path,
      filename: file.filename,
      declaredMime: file.mime,
      sourceUrl: file.url,
    };
    if (t.session.session.taskId !== undefined) q.taskId = t.session.session.taskId;
    const item = await this.deps.library.importDownload(q, sniffed);
    const download: DriverDownload = {
      id: newId("dl"),
      filename: file.filename,
      mime: item.mime,
      size: item.size,
      quarantined: true,
      libraryItemId: item.libraryItemId,
    };
    await this.deps.broker
      ?.recordReceipt({
        kind: "browser.download",
        outcome: "ok",
        summary: `Downloaded ${file.filename} (${item.mime}, ${item.size} bytes) to the Library quarantine`,
        taskId: t.session.session.taskId ?? null,
        externalRefs: { libraryItemId: item.libraryItemId, sha256: item.sha256 },
        payload: {
          sourceOrigin: t.page.origin ?? null,
          executable: item.executable,
          typeMismatch: item.mismatch,
        },
      })
      .catch(() => undefined);
    this.emit({ type: "download", tabId, download });
    const waiters = this.#downloadWaiters.get(tabId) ?? [];
    this.#downloadWaiters.delete(tabId);
    for (const w of waiters) w.resolve(download);
    return download;
  }

  protected downloadFailed(tabId: string, reason: string): void {
    const waiters = this.#downloadWaiters.get(tabId) ?? [];
    this.#downloadWaiters.delete(tabId);
    for (const w of waiters) w.reject(new PsycheError("unavailable", `download failed: ${reason}`));
  }

  /** For drivers that need it (Playwright's own dialog object). */
  protected pageOf(tabId: string): PageController | undefined {
    return this.tabs.get(tabId)?.page;
  }

  // Contract method kept for callers typed against `BrowserDriver`.
  async snapshotPage(tabId: string, options?: { maxRefs?: number }): Promise<PageSnapshot> {
    return this.snapshot(tabId, options);
  }
}
