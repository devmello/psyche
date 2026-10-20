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
import type { RecordingEventInput } from "../recording/recorder.ts";
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

/** Origin and path, for recording summaries (query strings carry tokens). */
function redactedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
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
    await this.#endRecording(s);
  }

  /** Finish the session's recording and register it in the Library (feature I10). */
  async #endRecording(s: SessionState): Promise<void> {
    const sink = s.recording;
    if (sink === undefined) return;
    try {
      const index = (await sink.end?.()) as
        | {
            id: string;
            taskId: string | null;
            threadId: string | null;
            frames: unknown[];
            events: unknown[];
          }
        | undefined;
      const dir = (sink as { dir?: string }).dir;
      if (index === undefined || dir === undefined) return;
      await this.deps.library.importRecording?.({
        id: index.id,
        dir,
        taskId: index.taskId,
        threadId: index.threadId,
        frameCount: index.frames.length,
        eventCount: index.events.length,
      });
    } catch {
      // A recording that cannot be finished never fails the session.
    }
  }

  // --- recording (I10) ---------------------------------------------------------------------

  /** Append to the session's recording, if any; never throws, never blocks the action. */
  protected record(tabId: string, input: Omit<RecordingEventInput, "tabId">): void {
    const t = this.tabs.get(tabId);
    const sink = t?.session.recording;
    if (t === undefined || sink?.event === undefined) return;
    const event: RecordingEventInput = { tabId, ...input };
    if (event.url === undefined && t.page.url !== "" && t.page.url !== "about:blank") {
      event.url = t.page.url;
    }
    void Promise.resolve(sink.event(event)).catch(() => undefined);
  }

  /** `button "Sign in"` from the latest snapshot, for recording summaries. */
  #elementOf(tabId: string, target: ActionTarget): Pick<RecordingEventInput, "ref" | "element"> {
    if (!("ref" in target)) return {};
    const meta = this.tabs.get(tabId)?.page.peek(target.ref);
    const out: Pick<RecordingEventInput, "ref" | "element"> = { ref: target.ref };
    if (meta !== undefined) out.element = { role: meta.role, name: meta.name };
    return out;
  }

  #describeTarget(tabId: string, target: ActionTarget): string {
    if (!("ref" in target)) return `(${target.x}, ${target.y})`;
    const meta = this.tabs.get(tabId)?.page.peek(target.ref);
    return meta === undefined ? target.ref : `${meta.role} ${JSON.stringify(meta.name)}`;
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
    const tabId = s.tabs.values().next().value;
    if (tabId !== undefined) {
      this.record(tabId, {
        kind: "control",
        summary:
          state === "user"
            ? "You took control"
            : state === "agent"
              ? "Control returned to the agent"
              : "The agent's input is paused",
        detail: { state },
      });
    }
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
    switch (e.type) {
      case "navigated":
        this.record(tabId, {
          kind: "navigation",
          summary: `Page is now ${redactedUrl(e.url)}`,
          url: e.url,
        });
        break;
      case "blocked":
        this.record(tabId, {
          kind: "blocked",
          summary: `Blocked ${redactedUrl(e.url)} (${e.reason})`,
          url: e.url,
          detail: { reason: e.reason },
        });
        break;
      case "dialog":
        this.record(tabId, {
          kind: "dialog",
          summary: `The page showed a dialog: ${e.message.slice(0, 200)}`,
          detail: { message: e.message.slice(0, 500) },
        });
        break;
      case "captcha":
        this.record(tabId, {
          kind: "blocked",
          summary: "A CAPTCHA appeared; handed to the owner",
          url: e.url,
        });
        break;
      default:
        break;
    }
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
    this.record(t.tab.id, {
      kind: "tab",
      summary: `Opened a ${choice.partition === "clean" ? "logged-out" : "profile"} tab${url === undefined ? "" : ` at ${redactedUrl(url)}`}`,
      ...(url === undefined ? {} : { url }),
      detail: { partition: choice.partition, reason: choice.reason },
    });
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
    this.record(tabId, { kind: "tab", summary: "Closed the tab" });
    await this.destroyTab(t);
    this.forgetTab(tabId);
  }

  // --- page operations ---------------------------------------------------------------------

  #page(tabId: string): PageController {
    return this.tabState(tabId).page;
  }

  navigate(tabId: string, url: string, options: CallOptions = {}): Promise<NavigateResult> {
    this.record(tabId, {
      kind: "action",
      action: "navigate",
      summary: `Opened ${redactedUrl(url)}`,
      url,
    });
    return this.#page(tabId).navigate(url, options);
  }
  back(tabId: string): Promise<NavigateResult> {
    this.record(tabId, { kind: "action", action: "back", summary: "Went back" });
    return this.#page(tabId).history(-1);
  }
  forward(tabId: string): Promise<NavigateResult> {
    this.record(tabId, { kind: "action", action: "forward", summary: "Went forward" });
    return this.#page(tabId).history(1);
  }
  reload(tabId: string): Promise<NavigateResult> {
    this.record(tabId, { kind: "action", action: "reload", summary: "Reloaded the page" });
    return this.#page(tabId).reload();
  }
  async snapshot(tabId: string, options?: SnapshotOptions): Promise<BrowserSnapshot> {
    const snap = await this.#page(tabId).snapshot(options);
    this.record(tabId, {
      kind: "snapshot",
      summary: `Read the page ${JSON.stringify(snap.title)}`,
      url: snap.url,
      snapshotText: snap.text,
      detail: { refs: snap.refs.length, page: snap.page, pages: snap.pages },
    });
    return snap;
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
    return this.pointer(tabId, { ref }, "click");
  }
  pointer(tabId: string, target: ActionTarget, action: PointerAction): Promise<void> {
    const verb = {
      click: "Clicked",
      double_click: "Double-clicked",
      right_click: "Right-clicked",
      hover: "Pointed at",
    }[action];
    this.record(tabId, {
      kind: "action",
      action,
      summary: `${verb} ${this.#describeTarget(tabId, target)}`,
      ...this.#elementOf(tabId, target),
    });
    return this.#page(tabId).pointer(target, action);
  }
  type(
    tabId: string,
    ref: string,
    text: string,
    options?: { submit?: boolean; clear?: boolean },
  ): Promise<void> {
    // The text is redacted by the sink; secure fields and placeholders are refused by the page.
    this.record(tabId, {
      kind: "action",
      action: "type",
      summary: `Typed into ${this.#describeTarget(tabId, { ref })}${options?.submit === true ? " and submitted" : ""}`,
      ...this.#elementOf(tabId, { ref }),
      detail: { text, submit: options?.submit === true, clear: options?.clear !== false },
    });
    return this.#page(tabId).type(ref, text, options);
  }
  select(tabId: string, ref: string, values: string[]): Promise<void> {
    this.record(tabId, {
      kind: "action",
      action: "select",
      summary: `Chose ${values.map((v) => JSON.stringify(v)).join(", ")} in ${this.#describeTarget(tabId, { ref })}`,
      ...this.#elementOf(tabId, { ref }),
      detail: { values },
    });
    return this.#page(tabId).select(ref, values);
  }
  scroll(
    tabId: string,
    options: { ref?: string; direction: "up" | "down" | "left" | "right"; amount?: number },
  ): Promise<void> {
    this.record(tabId, {
      kind: "action",
      action: "scroll",
      summary: `Scrolled ${options.direction}`,
      ...(options.ref === undefined ? {} : this.#elementOf(tabId, { ref: options.ref })),
      detail: {
        direction: options.direction,
        ...(options.amount === undefined ? {} : { amount: options.amount }),
      },
    });
    return this.#page(tabId).scroll(options);
  }
  scrollTo(tabId: string, ref: string): Promise<void> {
    this.record(tabId, {
      kind: "action",
      action: "scroll_to",
      summary: `Scrolled to ${this.#describeTarget(tabId, { ref })}`,
      ...this.#elementOf(tabId, { ref }),
    });
    return this.#page(tabId).scrollTo(ref);
  }
  press(tabId: string, keys: string, options?: { ref?: string }): Promise<void> {
    this.record(tabId, {
      kind: "action",
      action: "press",
      summary: `Pressed ${keys}`,
      ...(options?.ref === undefined ? {} : this.#elementOf(tabId, { ref: options.ref })),
      detail: { keys },
    });
    return this.#page(tabId).press(keys, options);
  }
  drag(tabId: string, from: ActionTarget, to: ActionTarget): Promise<void> {
    this.record(tabId, {
      kind: "action",
      action: "drag",
      summary: `Dragged ${this.#describeTarget(tabId, from)} to ${this.#describeTarget(tabId, to)}`,
      ...this.#elementOf(tabId, from),
    });
    return this.#page(tabId).drag(from, to);
  }
  upload(tabId: string, ref: string, paths: string[]): Promise<void> {
    // Library paths stay out of the recording; the count is enough for Activity.
    this.record(tabId, {
      kind: "action",
      action: "upload",
      summary: `Attached ${paths.length} file${paths.length === 1 ? "" : "s"} to ${this.#describeTarget(tabId, { ref })}`,
      ...this.#elementOf(tabId, { ref }),
      detail: { files: paths.length },
    });
    return this.#page(tabId).upload(ref, paths);
  }
  readText(tabId: string, options?: { maxChars?: number }) {
    this.record(tabId, { kind: "action", action: "read_text", summary: "Read the page text" });
    return this.#page(tabId).readText(options);
  }
  screenshot(tabId: string) {
    this.record(tabId, { kind: "action", action: "screenshot", summary: "Looked at the page" });
    return this.#page(tabId).screenshot();
  }
  handleDialog(tabId: string, accept: boolean, promptText?: string): Promise<void> {
    this.record(tabId, {
      kind: "action",
      action: "dialog",
      summary: accept ? "Accepted the dialog" : "Dismissed the dialog",
      detail: { accept, ...(promptText === undefined ? {} : { promptText }) },
    });
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
    // Never the value: the credential id, the element and the origin are all Activity sees.
    this.record(tabId, {
      kind: "fill",
      action: "fill_credential",
      summary: `Filled a credential from the vault into ${this.#describeTarget(tabId, { ref })}`,
      ...this.#elementOf(tabId, { ref }),
      detail: { credentialId: secret.credentialId, origin },
    });
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
    this.record(tabId, {
      kind: "action",
      action: "download",
      summary:
        "ref" in source
          ? `Downloaded from ${this.#describeTarget(tabId, source)}`
          : `Downloaded ${redactedUrl(source.url)}`,
      ...("ref" in source ? this.#elementOf(tabId, source) : { url: source.url }),
    });
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
    this.record(tabId, {
      kind: "download",
      summary: `${file.filename} (${item.mime}, ${item.size} bytes) landed in the Library quarantine`,
      detail: {
        filename: file.filename,
        mime: item.mime,
        size: item.size,
        libraryItemId: item.libraryItemId,
      },
    });
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
