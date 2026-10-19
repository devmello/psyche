import { PsycheError, type Unsubscribe } from "@psyche/protocol";
import type { CdpTarget } from "../cdp/page.ts";
import type { AXNode, CaptureSnapshotResult, DocumentSnapshot } from "../cdp/types.ts";
import {
  FIXTURE_SITE,
  type FxAction,
  type FxHost,
  type FxNode,
  type FxPage,
  type FxSite,
  keyFor,
  NOT_FOUND_PAGE,
  resolveHref,
  submissionPage,
} from "./site.ts";

/**
 * In-memory CDP page model over the fixture DSL: enough of Chromium's behaviour (AX tree,
 * DOMSnapshot with device-pixel layout, hit testing, focus, typing, forms, redirects with
 * `Network.requestWillBeSent` hops, dialogs, popups, downloads, screencast) to run the driver
 * conformance suite without a browser. Used directly as a `CdpTarget` and behind
 * `MockDesktop` (the bridge).
 */

const DPR = 2;
const VIEWPORT = { width: 1280, height: 800 };
const ROW = 30;
const GAP = 10;

interface MockEl {
  id: number;
  tag: string;
  parent: MockEl | undefined;
  children: MockEl[];
  attrs: Record<string, string>;
  fx?: FxNode;
  /** Text content for leaf text-bearing elements. */
  text?: string;
  value?: string;
  checked?: boolean;
  files?: string[];
  box?: { x: number; y: number; width: number; height: number };
  clickable: boolean;
  /** Child document for iframes. */
  frame?: MockDoc;
  label?: string;
}

interface MockDoc {
  frameId: string;
  url: string;
  title: string;
  root: MockEl;
  els: Map<number, MockEl>;
  crossOrigin: boolean;
  height: number;
}

export interface MockDownload {
  url: string;
  filename: string;
  mime: string;
  body: string;
}

export interface MockBrowserHooks {
  /** A tab opened a popup (`window.open`, `target=_blank`). */
  onPopup?: (opener: MockTab, url: string) => MockTab;
  onClose?: (tab: MockTab) => void;
  onDownload?: (tab: MockTab, download: MockDownload) => void;
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

export class MockBrowser {
  readonly site: FxSite;
  readonly port: number;
  readonly submissions: { path: string; fields: [string, string][] }[] = [];
  readonly tabs = new Map<string, MockTab>();
  hooks: MockBrowserHooks = {};
  /** Per-hop network latency, so stop/commit races look like a real browser's. */
  latencyMs: number;
  #nextBackend = 1;
  #nextTab = 1;
  #nextReq = 1;

  constructor(options: { site?: FxSite; port?: number; latencyMs?: number } = {}) {
    this.site = options.site ?? FIXTURE_SITE;
    this.port = options.port ?? 47_801;
    this.latencyMs = options.latencyMs ?? 1;
  }

  origin = (h: FxHost): string =>
    `http://${h === "a" ? "site-a" : h === "b" ? "site-b" : "evil"}.localhost:${this.port}`;

  url(key: string): string {
    const i = key.indexOf("/");
    return resolveHref(key.slice(i), key.slice(0, i) as FxHost, this.origin);
  }

  backendId(): number {
    return this.#nextBackend++;
  }
  requestId(): string {
    return `R${this.#nextReq++}`;
  }

  openTab(options: { url?: string; opener?: MockTab } = {}): MockTab {
    const id = `mt${this.#nextTab++}`;
    const tab = new MockTab(this, id, options.opener);
    this.tabs.set(id, tab);
    if (options.url !== undefined) void tab.navigateTo(options.url, "GET");
    return tab;
  }

  closeTab(tab: MockTab): void {
    if (!this.tabs.delete(tab.id)) return;
    tab.closed = true;
    this.hooks.onClose?.(tab);
  }

  /** Resolve a fixture URL to what serving it would produce. */
  resolve(
    url: string,
  ):
    | { kind: "redirect"; to: string }
    | { kind: "download"; download: MockDownload }
    | { kind: "page"; page: FxPage; host: FxHost; status: number }
    | { kind: "unreachable" } {
    const key = keyFor(url, this.origin);
    if (key === undefined) return { kind: "unreachable" };
    const host = key.slice(0, key.indexOf("/")) as FxHost;
    const redirect = this.site.redirects[key];
    if (redirect !== undefined)
      return { kind: "redirect", to: resolveHref(redirect, host, this.origin) };
    const dl = this.site.downloads[key];
    if (dl !== undefined) return { kind: "download", download: { url, ...dl } };
    const path = key.slice(key.indexOf("/"));
    if (path.startsWith("/submit/")) {
      const fields = [...new URL(url).searchParams.entries()];
      return { kind: "page", page: submissionPage(path, fields), host, status: 200 };
    }
    const page =
      this.site.pages[key] ??
      (path.startsWith("/spa/") ? this.site.pages[`${host}/spa`] : undefined);
    if (page === undefined) return { kind: "page", page: NOT_FOUND_PAGE, host, status: 404 };
    return { kind: "page", page, host, status: page.status ?? 200 };
  }
}

type Listener = (method: string, params: unknown) => void;

export class MockTab implements CdpTarget {
  readonly id: string;
  readonly browser: MockBrowser;
  readonly opener: MockTab | undefined;
  closed = false;
  url = "about:blank";
  title = "";
  #listeners = new Set<Listener>();
  #doc: MockDoc;
  #history: { id: number; url: string; title: string }[] = [];
  #index = -1;
  #nextEntry = 1;
  #loader = 0;
  #frameId: string;
  #scrollY = 0;
  #focused: MockEl | undefined;
  #selectAll = false;
  #dialog: { type: "alert" | "confirm"; message: string; then?: FxAction } | undefined;
  #nav: { stopped: boolean } | undefined;
  #worlds = new Map<number, string>();
  #nextCtx = 100;
  #objects = new Map<string, number>();
  #nextObj = 1;
  #screencast = false;
  /** Methods received, for assertions about what the driver sent. */
  readonly calls: string[] = [];

  constructor(browser: MockBrowser, id: string, opener: MockTab | undefined) {
    this.browser = browser;
    this.id = id;
    this.opener = opener;
    this.#frameId = `F-${id}`;
    this.#doc = this.#build({ title: "", body: [] }, "about:blank", "a", this.#frameId, false);
  }

  on(listener: Listener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(method: string, params: unknown): void {
    for (const l of [...this.#listeners]) l(method, params);
  }

  get statusText(): string | undefined {
    for (const el of this.#doc.els.values()) if (el.attrs.id === "status") return el.text;
    return undefined;
  }

  fieldValue(name: string): string | undefined {
    for (const el of this.#doc.els.values()) if (el.attrs.name === name) return el.value;
    return undefined;
  }

  // --- document model ----------------------------------------------------------------------

  #build(page: FxPage, url: string, host: FxHost, frameId: string, crossOrigin: boolean): MockDoc {
    const b = this.browser;
    const els = new Map<number, MockEl>();
    const mk = (tag: string, parent: MockEl | undefined, extra: Partial<MockEl> = {}): MockEl => {
      const el: MockEl = {
        id: b.backendId(),
        tag,
        parent,
        children: [],
        attrs: {},
        clickable: false,
        ...extra,
      };
      parent?.children.push(el);
      els.set(el.id, el);
      return el;
    };
    const root = mk("#document", undefined);
    const html = mk("HTML", root);
    const body = mk("BODY", html);
    let y = 20;
    const leaf = (el: MockEl, width: number, height = ROW) => {
      el.box = { x: 20, y, width, height };
      y += height + GAP;
    };
    let field = 0;
    const add = (n: FxNode, parent: MockEl, form: MockEl | undefined): void => {
      switch (n.kind) {
        case "heading": {
          const el = mk(`H${n.level}`, parent, { fx: n, text: n.text });
          leaf(el, 600, 40);
          return;
        }
        case "text": {
          leaf(mk("P", parent, { fx: n, text: n.text }), 900);
          return;
        }
        case "status": {
          const el = mk("P", parent, { fx: n, text: n.text });
          el.attrs.id = n.id;
          el.attrs.role = "status";
          leaf(el, 600);
          return;
        }
        case "link": {
          const p = mk("P", parent);
          const el = mk("A", p, { fx: n, text: n.text, clickable: true });
          el.attrs.href = resolveHref(n.href, host, b.origin);
          if (n.target !== undefined) el.attrs.target = n.target;
          leaf(el, 300);
          p.box = el.box;
          return;
        }
        case "button": {
          const el = mk("BUTTON", parent, { fx: n, text: n.text, clickable: true });
          el.attrs.type = n.type ?? (n.onClick === undefined ? "submit" : "button");
          leaf(el, 200);
          return;
        }
        case "input": {
          const p = mk("P", parent);
          const id = `f${++field}`;
          mk("LABEL", p, { text: n.label }).attrs.for = id;
          const el = mk("INPUT", p, {
            fx: n,
            clickable: true,
            label: n.label,
            value: n.value ?? "",
          });
          Object.assign(el.attrs, { id, name: n.name, type: n.type ?? "text" });
          if (n.autocomplete !== undefined) el.attrs.autocomplete = n.autocomplete;
          if (n.required === true) el.attrs.required = "";
          if (n.type === "checkbox") el.checked = false;
          leaf(el, 300);
          p.box = el.box;
          return;
        }
        case "select": {
          const p = mk("P", parent);
          const id = `f${++field}`;
          mk("LABEL", p, { text: n.label }).attrs.for = id;
          const el = mk("SELECT", p, {
            fx: n,
            clickable: true,
            label: n.label,
            value: n.options[0] ?? "",
          });
          Object.assign(el.attrs, { id, name: n.name });
          for (const o of n.options) mk("OPTION", el, { text: o }).attrs.value = o;
          leaf(el, 300);
          p.box = el.box;
          return;
        }
        case "form": {
          const el = mk("FORM", parent, { fx: n });
          el.attrs.action = resolveHref(n.action, host, b.origin);
          el.attrs.method = n.method ?? "get";
          for (const c of n.children) add(c, el, el);
          return;
        }
        case "section": {
          const tag = {
            main: "MAIN",
            navigation: "NAV",
            region: "SECTION",
            banner: "HEADER",
            contentinfo: "FOOTER",
          }[n.role];
          const el = mk(tag, parent, { fx: n });
          if (n.label !== undefined) el.attrs["aria-label"] = n.label;
          for (const c of n.children) add(c, el, form);
          return;
        }
        case "list": {
          const ul = mk("UL", parent, { fx: n });
          for (const item of n.items) add(item, mk("LI", ul), form);
          return;
        }
        case "table": {
          const t = mk("TABLE", parent, { fx: n, text: n.caption });
          n.rows.forEach((r, i) => {
            const tr = mk("TR", t);
            for (const c of r) leaf(mk(i === 0 ? "TH" : "TD", tr, { text: c }), 150);
          });
          return;
        }
        case "iframe": {
          const src = resolveHref(n.src, host, b.origin);
          const el = mk("IFRAME", parent, { fx: n });
          Object.assign(el.attrs, { src, title: n.title });
          leaf(el, 400, 120);
          const r = b.resolve(src);
          const childCross = new URL(src).origin !== new URL(url).origin;
          if (r.kind === "page") {
            el.frame = this.#build(r.page, src, r.host, `${frameId}.${el.id}`, childCross);
          }
          return;
        }
        case "canvas": {
          leaf(mk("CANVAS", parent, { fx: n }), n.width, n.height);
          return;
        }
        case "image": {
          const el = mk("IMG", parent, { fx: n });
          el.attrs.alt = n.alt;
          leaf(el, 64, 64);
          return;
        }
        case "clickable": {
          leaf(mk("DIV", parent, { fx: n, text: n.text, clickable: true }), 200);
          return;
        }
        case "spacer": {
          leaf(mk("DIV", parent, { fx: n }), 10, n.height);
          return;
        }
      }
    };
    for (const n of page.body) add(n, body, undefined);
    void form;
    return { frameId, url, title: page.title, root, els, crossOrigin, height: y };
  }

  // --- CDP ---------------------------------------------------------------------------------

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new PsycheError("not_found", "target closed");
    this.calls.push(method);
    return (await this.#handle(method, params)) as T;
  }

  async #handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "Page.enable":
      case "Page.disable":
      case "Runtime.enable":
      case "Network.enable":
      case "DOM.enable":
      case "Page.screencastFrameAck":
        return {};
      case "Page.getFrameTree":
        return { frameTree: this.#frameTree() };
      case "Page.getLayoutMetrics":
        return {
          layoutViewport: {
            pageX: 0,
            pageY: this.#scrollY * DPR,
            clientWidth: VIEWPORT.width * DPR,
            clientHeight: VIEWPORT.height * DPR,
          },
          cssLayoutViewport: {
            pageX: 0,
            pageY: this.#scrollY,
            clientWidth: VIEWPORT.width,
            clientHeight: VIEWPORT.height,
          },
          cssVisualViewport: {
            pageX: 0,
            pageY: this.#scrollY,
            clientWidth: VIEWPORT.width,
            clientHeight: VIEWPORT.height,
            offsetX: 0,
            offsetY: 0,
            scale: 1,
          },
          cssContentSize: { x: 0, y: 0, width: VIEWPORT.width, height: this.#doc.height },
        };
      case "Accessibility.getFullAXTree": {
        const frameId = p.frameId as string | undefined;
        if (frameId === undefined || frameId === this.#frameId)
          return { nodes: axTree(this.#doc, this.#focused) };
        const child = this.#childDoc(frameId);
        if (child === undefined || child.crossOrigin)
          throw new PsycheError("not_found", "Frame with the given id was not found.");
        return { nodes: axTree(child, this.#focused) };
      }
      case "DOMSnapshot.captureSnapshot":
        return domSnapshot(this.#doc);
      case "Page.getNavigationHistory":
        return { currentIndex: this.#index, entries: this.#history.map((e) => ({ ...e })) };
      case "Page.navigate": {
        const url = String(p.url);
        const final = this.#finalTarget(url);
        void this.navigateTo(url, "GET");
        if (final === "download") return { frameId: this.#frameId, errorText: "net::ERR_ABORTED" };
        return { frameId: this.#frameId, loaderId: `L${this.#loader + 1}` };
      }
      case "Page.navigateToHistoryEntry": {
        const i = this.#history.findIndex((e) => e.id === p.entryId);
        if (i === -1) throw new PsycheError("invalid_params", "No entry with passed id");
        const e = this.#history[i];
        if (e !== undefined) void this.navigateTo(e.url, "GET", { historyIndex: i });
        return {};
      }
      case "Page.reload":
        void this.navigateTo(this.url, "GET", { historyIndex: this.#index });
        return {};
      case "Page.stopLoading":
        if (this.#nav !== undefined) this.#nav.stopped = true;
        return {};
      case "Page.createIsolatedWorld": {
        const ctx = this.#nextCtx++;
        this.#worlds.set(ctx, String(p.frameId));
        return { executionContextId: ctx };
      }
      case "DOM.getDocument":
        return { root: { nodeId: 1, backendNodeId: this.#doc.root.id, nodeName: "#document" } };
      case "DOM.resolveNode": {
        const el = this.#el(p.backendNodeId);
        if (!this.#worlds.has(Number(p.executionContextId)))
          throw new PsycheError("invalid_params", "Cannot find context with specified id");
        const objectId = `obj${this.#nextObj++}`;
        this.#objects.set(objectId, el.id);
        return { object: { type: "object", objectId } };
      }
      case "Runtime.callFunctionOn":
        return this.#callFunction(p);
      case "Runtime.evaluate":
        throw new PsycheError("forbidden", "mock: main-world evaluate is not modelled");
      case "DOM.scrollIntoViewIfNeeded": {
        const el = this.#el(p.backendNodeId);
        const box = el.box ?? el.parent?.box;
        if (
          box !== undefined &&
          (box.y < this.#scrollY || box.y + box.height > this.#scrollY + VIEWPORT.height)
        ) {
          this.#scrollY = Math.max(0, box.y - 100);
        }
        return {};
      }
      case "DOM.getContentQuads": {
        const el = this.#el(p.backendNodeId);
        const b = el.box;
        if (b === undefined || b.width <= 0 || b.height <= 0) return { quads: [] };
        const y = b.y - this.#scrollY;
        return {
          quads: [[b.x, y, b.x + b.width, y, b.x + b.width, y + b.height, b.x, y + b.height]],
        };
      }
      case "DOM.focus": {
        const el = this.#el(p.backendNodeId);
        if (!["INPUT", "SELECT", "BUTTON", "A", "TEXTAREA"].includes(el.tag)) {
          throw new PsycheError("invalid_params", "Element is not focusable");
        }
        this.#focused = el;
        this.#selectAll = false;
        return {};
      }
      case "DOM.setFileInputFiles": {
        const el = this.#el(p.backendNodeId);
        if (el.attrs.type !== "file")
          throw new PsycheError("invalid_params", "Node is not a file input element");
        el.files = (p.files as string[]).map((f) => f.split("/").pop() ?? f);
        el.value = el.files[0] === undefined ? "" : `C:\\fakepath\\${el.files[0]}`;
        return {};
      }
      case "Input.dispatchMouseEvent":
        return this.#mouse(p);
      case "Input.insertText": {
        const el = this.#focused;
        if (
          el !== undefined &&
          el.tag === "INPUT" &&
          el.attrs.type !== "checkbox" &&
          el.attrs.type !== "file"
        ) {
          el.value = (this.#selectAll ? "" : (el.value ?? "")) + String(p.text);
          this.#selectAll = false;
        }
        return {};
      }
      case "Input.dispatchKeyEvent":
        return this.#key(p);
      case "Page.handleJavaScriptDialog": {
        const d = this.#dialog;
        if (d === undefined) throw new PsycheError("invalid_params", "No dialog is showing");
        this.#dialog = undefined;
        this.#emit("Page.javascriptDialogClosed", { result: p.accept === true, userInput: "" });
        if (d.type === "confirm" && p.accept === true && d.then !== undefined) this.#run(d.then);
        return {};
      }
      case "Page.captureScreenshot":
        return {
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
        };
      case "Page.startScreencast":
        this.#screencast = true;
        void this.#frames();
        return {};
      case "Page.stopScreencast":
        this.#screencast = false;
        return {};
      default:
        throw new PsycheError("unknown_method", `mock: '${method}' wasn't found`);
    }
  }

  async #frames(): Promise<void> {
    for (let i = 1; i <= 3 && this.#screencast && !this.closed; i++) {
      await tick(2);
      const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, i]).toString("base64");
      this.#emit("Page.screencastFrame", {
        data,
        sessionId: i,
        metadata: { timestamp: Date.now() / 1000 },
      });
    }
  }

  #frameTree() {
    const children = [...this.#doc.els.values()]
      .filter((e) => e.frame !== undefined)
      .map((e) => ({
        frame: {
          id: e.frame?.frameId ?? "",
          parentId: this.#frameId,
          url: e.frame?.url ?? "",
          loaderId: "Lchild",
        },
      }));
    return {
      frame: {
        id: this.#frameId,
        url: this.url,
        loaderId: `L${this.#loader}`,
        securityOrigin: safeOrigin(this.url),
      },
      childFrames: children,
    };
  }

  #childDoc(frameId: string): MockDoc | undefined {
    for (const e of this.#doc.els.values()) if (e.frame?.frameId === frameId) return e.frame;
    return undefined;
  }

  #el(backendNodeId: unknown): MockEl {
    const el = this.#doc.els.get(Number(backendNodeId));
    if (el === undefined) throw new PsycheError("not_found", "No node with given id found");
    return el;
  }

  #callFunction(p: Record<string, unknown>): unknown {
    const id = this.#objects.get(String(p.objectId));
    if (id === undefined)
      throw new PsycheError("invalid_params", "Could not find object with given id");
    const el = this.#el(id);
    const fn = String(p.functionDeclaration);
    const args = (p.arguments as { value?: unknown }[] | undefined) ?? [];
    if (fn.includes("psyche:select")) {
      if (el.tag !== "SELECT")
        return { result: { type: "object", value: { ok: false, reason: "not_select" } } };
      const want = new Set((args[0]?.value as string[] | undefined) ?? []);
      const opt = el.children.find((o) => want.has(o.attrs.value ?? "") || want.has(o.text ?? ""));
      if (opt !== undefined) el.value = opt.attrs.value ?? "";
      return {
        result: {
          type: "object",
          value: { ok: opt !== undefined, matched: opt === undefined ? 0 : 1 },
        },
      };
    }
    if (fn.includes("psyche:download")) {
      void this.navigateTo(String(args[0]?.value), "GET", { downloadOnly: true });
      return { result: { type: "object", value: { ok: true } } };
    }
    throw new PsycheError("forbidden", "mock: only the fixed psyche helpers are modelled");
  }

  #hit(x: number, y: number): MockEl | undefined {
    const docY = y + this.#scrollY;
    let best: MockEl | undefined;
    for (const el of this.#doc.els.values()) {
      const b = el.box;
      if (b === undefined || !el.clickable) continue;
      if (x >= b.x && x <= b.x + b.width && docY >= b.y && docY <= b.y + b.height) best = el;
    }
    return best;
  }

  #mouse(p: Record<string, unknown>): unknown {
    if (this.#dialog !== undefined && p.type !== "mouseMoved") return {};
    if (p.type === "mouseWheel") {
      const max = Math.max(0, this.#doc.height - VIEWPORT.height);
      this.#scrollY = Math.min(max, Math.max(0, this.#scrollY + Number(p.deltaY ?? 0)));
      return {};
    }
    if (p.type !== "mouseReleased" || p.button !== "left" || p.clickCount !== 1) return {};
    const el = this.#hit(Number(p.x), Number(p.y));
    if (el !== undefined) this.#activate(el);
    return {};
  }

  #activate(el: MockEl): void {
    const fx = el.fx;
    if (["INPUT", "SELECT", "BUTTON", "A"].includes(el.tag)) this.#focused = el;
    if (el.tag === "A") {
      const href = el.attrs.href ?? "";
      if (el.attrs.target === "_blank") this.#popup(href);
      else void this.navigateTo(href, "GET");
      return;
    }
    if (el.tag === "INPUT" && el.attrs.type === "checkbox") {
      el.checked = el.checked !== true;
      return;
    }
    if (el.tag === "INPUT" && el.attrs.type === "submit") {
      this.#submit(el);
      return;
    }
    if (el.tag === "BUTTON") {
      if (fx?.kind === "button" && fx.onClick !== undefined) this.#run(fx.onClick);
      else if (el.attrs.type === "submit") this.#submit(el);
      return;
    }
    if (fx?.kind === "clickable") this.#run(fx.onClick);
  }

  #key(p: Record<string, unknown>): unknown {
    if (p.type === "keyUp") return {};
    const commands = (p.commands as string[] | undefined) ?? [];
    if (commands.includes("selectAll")) {
      this.#selectAll = true;
      return {};
    }
    const el = this.#focused;
    if (p.key === "Enter" && el !== undefined) {
      if (el.tag === "INPUT" || el.tag === "BUTTON") this.#submit(el);
      else if (el.tag === "A") this.#activate(el);
      return {};
    }
    if (p.key === "Backspace" && el?.value !== undefined) {
      el.value = this.#selectAll ? "" : el.value.slice(0, -1);
      this.#selectAll = false;
      return {};
    }
    if (p.key === "Tab") {
      const focusables = [...this.#doc.els.values()].filter((e) =>
        ["INPUT", "SELECT", "BUTTON", "A"].includes(e.tag),
      );
      const i = el === undefined ? -1 : focusables.indexOf(el);
      this.#focused = focusables[(i + 1) % Math.max(1, focusables.length)];
      return {};
    }
    if (typeof p.text === "string" && el?.tag === "INPUT") el.value = (el.value ?? "") + p.text;
    return {};
  }

  #submit(from: MockEl): void {
    let form: MockEl | undefined = from;
    while (form !== undefined && form.tag !== "FORM") form = form.parent;
    if (form === undefined) return;
    const fields: [string, string][] = [];
    const walk = (e: MockEl) => {
      const name = e.attrs.name;
      if (name !== undefined && (e.tag === "INPUT" || e.tag === "SELECT")) {
        if (e.attrs.type === "checkbox") {
          if (e.checked === true) fields.push([name, "on"]);
        } else if (e.attrs.type === "file") fields.push([name, e.files?.[0] ?? ""]);
        else fields.push([name, e.value ?? ""]);
      }
      for (const c of e.children) walk(c);
    };
    walk(form);
    const action = form.attrs.action ?? this.url;
    const method = (form.attrs.method ?? "get").toUpperCase();
    this.browser.submissions.push({ path: new URL(action).pathname, fields });
    const target = new URL(action);
    if (method === "GET") for (const [k, v] of fields) target.searchParams.append(k, v);
    void this.navigateTo(target.href, method, method === "POST" ? { postFields: fields } : {});
  }

  #run(a: FxAction): void {
    switch (a.kind) {
      case "alert":
      case "confirm": {
        const d: { type: "alert" | "confirm"; message: string; then?: FxAction } = {
          type: a.kind,
          message: a.message,
        };
        if (a.kind === "confirm") d.then = a.then;
        this.#dialog = d;
        this.#emit("Page.javascriptDialogOpening", {
          url: this.url,
          message: a.message,
          type: a.kind,
          hasBrowserHandler: false,
        });
        return;
      }
      case "navigate":
        void this.navigateTo(this.#resolve(a.href), "GET");
        return;
      case "popup":
        this.#popup(this.#resolve(a.href));
        return;
      case "set_text":
        for (const el of this.#doc.els.values()) if (el.attrs.id === a.id) el.text = a.text;
        return;
      case "push_state": {
        const url = new URL(a.href, this.url).href;
        this.url = url;
        this.#history = this.#history.slice(0, this.#index + 1);
        this.#history.push({ id: this.#nextEntry++, url, title: this.title });
        this.#index = this.#history.length - 1;
        this.#emit("Page.navigatedWithinDocument", { frameId: this.#frameId, url });
        return;
      }
      case "post_to_opener_and_close": {
        const opener = this.opener;
        if (opener !== undefined && !opener.closed)
          opener.#run({ kind: "set_text", id: "status", text: `Received: ${a.message}` });
        this.browser.closeTab(this);
        return;
      }
    }
  }

  #resolve(href: string): string {
    if (/^https?:/.test(href)) return href;
    const key = keyFor(this.url, this.browser.origin);
    const host = (key?.slice(0, key.indexOf("/")) ?? "a") as FxHost;
    return resolveHref(href, host, this.browser.origin);
  }

  #popup(url: string): void {
    const hook = this.browser.hooks.onPopup;
    if (hook !== undefined) hook(this, url);
    else this.browser.openTab({ url, opener: this });
  }

  #finalTarget(url: string): "download" | "other" {
    let u = url;
    for (let i = 0; i < 10; i++) {
      const r = this.browser.resolve(u);
      if (r.kind === "download") return "download";
      if (r.kind !== "redirect") return "other";
      u = r.to;
    }
    return "other";
  }

  /** Run one navigation with per-hop network events; honours `Page.stopLoading`. */
  async navigateTo(
    url: string,
    method: string,
    options: {
      historyIndex?: number;
      downloadOnly?: boolean;
      postFields?: [string, string][];
    } = {},
  ): Promise<void> {
    if (this.#nav !== undefined) this.#nav.stopped = true;
    const nav = { stopped: false };
    this.#nav = nav;
    const b = this.browser;
    const requestId = b.requestId();
    const loaderId = `L${this.#loader + 1}`;
    let current = url;
    let redirectResponse: unknown;
    this.#emit("Page.frameStartedLoading", { frameId: this.#frameId });
    for (let hop = 0; hop < 10; hop++) {
      const ev: Record<string, unknown> = {
        requestId,
        loaderId,
        documentURL: current,
        type: "Document",
        frameId: this.#frameId,
        request: { url: current, method },
        timestamp: Date.now() / 1000,
      };
      if (redirectResponse !== undefined) ev.redirectResponse = redirectResponse;
      this.#emit("Network.requestWillBeSent", ev);
      await tick(b.latencyMs);
      if (nav.stopped || this.closed) {
        this.#emit("Network.loadingFailed", {
          requestId,
          errorText: "net::ERR_ABORTED",
          canceled: true,
        });
        return;
      }
      const r = b.resolve(current);
      if (r.kind === "redirect") {
        redirectResponse = { url: current, status: 302, headers: { location: r.to } };
        current = r.to;
        continue;
      }
      if (r.kind === "unreachable") {
        await tick(b.latencyMs * 5);
        this.#emit("Network.loadingFailed", {
          requestId,
          errorText: "net::ERR_CONNECTION_TIMED_OUT",
        });
        return;
      }
      if (r.kind === "download") {
        this.#emit("Network.loadingFinished", { requestId });
        b.hooks.onDownload?.(this, r.download);
        this.#emit("Page.frameStoppedLoading", { frameId: this.#frameId });
        return;
      }
      if (options.downloadOnly === true) return;
      let page = r.page;
      if (options.postFields !== undefined && new URL(current).pathname.startsWith("/submit/")) {
        page = submissionPage(new URL(current).pathname, options.postFields);
      }
      this.#emit("Network.responseReceived", {
        requestId,
        loaderId,
        type: "Document",
        frameId: this.#frameId,
        response: { url: current, status: r.status, mimeType: "text/html" },
      });
      this.#loader++;
      this.url = current;
      this.title = page.title;
      this.#scrollY = 0;
      this.#focused = undefined;
      this.#dialog = undefined;
      this.#worlds.clear();
      this.#objects.clear();
      this.#doc = this.#build(page, current, r.host, this.#frameId, false);
      if (options.historyIndex !== undefined) {
        this.#index = options.historyIndex;
        const e = this.#history[this.#index];
        if (e !== undefined) e.title = page.title;
      } else {
        this.#history = this.#history.slice(0, this.#index + 1);
        this.#history.push({ id: this.#nextEntry++, url: current, title: page.title });
        this.#index = this.#history.length - 1;
      }
      this.#emit("Page.frameNavigated", {
        frame: {
          id: this.#frameId,
          url: current,
          loaderId,
          securityOrigin: safeOrigin(current),
          mimeType: "text/html",
        },
        type: "Navigation",
      });
      this.#emit("Network.loadingFinished", { requestId });
      await tick(b.latencyMs);
      this.#emit("Page.domContentEventFired", { timestamp: Date.now() / 1000 });
      this.#emit("Page.loadEventFired", { timestamp: Date.now() / 1000 });
      this.#emit("Page.frameStoppedLoading", { frameId: this.#frameId });
      if (this.#nav === nav) this.#nav = undefined;
      return;
    }
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

// --- AX and DOMSnapshot rendering ------------------------------------------------------------

function axTree(doc: MockDoc, focused: MockEl | undefined): AXNode[] {
  const nodes: AXNode[] = [];
  let seq = 0;
  const v = (value: unknown) => ({
    type: typeof value === "boolean" ? "boolean" : "string",
    value,
  });
  const add = (n: Omit<AXNode, "nodeId" | "childIds">, parentId: string | undefined): AXNode => {
    const node: AXNode = { nodeId: `${doc.frameId}:${++seq}`, childIds: [], ...n };
    if (parentId !== undefined) node.parentId = parentId;
    nodes.push(node);
    if (parentId !== undefined)
      nodes.find((x) => x.nodeId === parentId)?.childIds?.push(node.nodeId);
    return node;
  };
  const text = (t: string, parent: AXNode) =>
    add({ ignored: false, role: v("StaticText"), name: v(t) }, parent.nodeId);
  const root = add(
    {
      ignored: false,
      role: v("RootWebArea"),
      name: v(doc.title),
      backendDOMNodeId: doc.root.id,
      frameId: doc.frameId,
    },
    undefined,
  );
  const walk = (el: MockEl, parent: AXNode): void => {
    const props: { name: string; value: { type: string; value: unknown } }[] = [];
    if (el === focused) props.push({ name: "focused", value: v(true) });
    const base = { ignored: false, backendDOMNodeId: el.id };
    const kids = () => {
      for (const c of el.children) walk(c, node ?? parent);
    };
    let node: AXNode | undefined;
    switch (el.tag) {
      case "HTML":
      case "BODY":
        node = add({ ...base, ignored: true, role: v("none") }, parent.nodeId);
        kids();
        return;
      case "H1":
      case "H2":
      case "H3":
        node = add(
          {
            ...base,
            role: v("heading"),
            name: v(el.text ?? ""),
            properties: [
              ...props,
              { name: "level", value: { type: "integer", value: Number(el.tag[1]) } },
            ],
          },
          parent.nodeId,
        );
        text(el.text ?? "", node);
        return;
      case "P":
        node = add(
          { ...base, role: v(el.attrs.role === "status" ? "status" : "paragraph"), name: v("") },
          parent.nodeId,
        );
        if (el.text !== undefined) text(el.text, node);
        kids();
        return;
      case "A":
        node = add(
          { ...base, role: v("link"), name: v(el.text ?? ""), properties: props },
          parent.nodeId,
        );
        text(el.text ?? "", node);
        return;
      case "BUTTON":
        node = add(
          { ...base, role: v("button"), name: v(el.text ?? ""), properties: props },
          parent.nodeId,
        );
        text(el.text ?? "", node);
        return;
      case "LABEL":
        node = add({ ...base, role: v("LabelText"), name: v("") }, parent.nodeId);
        text(el.text ?? "", node);
        return;
      case "INPUT": {
        const type = el.attrs.type ?? "text";
        if (el.attrs.required !== undefined) props.push({ name: "required", value: v(true) });
        if (type === "checkbox") {
          props.push({
            name: "checked",
            value: { type: "tristate", value: el.checked === true ? "true" : "false" },
          });
          add(
            { ...base, role: v("checkbox"), name: v(el.label ?? ""), properties: props },
            parent.nodeId,
          );
        } else if (type === "file") {
          add(
            { ...base, role: v("button"), name: v(el.label ?? ""), properties: props },
            parent.nodeId,
          );
        } else {
          const raw = el.value ?? "";
          const shown = type === "password" ? "•".repeat(raw.length) : raw;
          node = add(
            {
              ...base,
              role: v(type === "search" ? "searchbox" : "textbox"),
              name: v(el.label ?? ""),
              value: v(shown),
              properties: props,
            },
            parent.nodeId,
          );
          if (shown !== "") text(shown, node);
        }
        return;
      }
      case "SELECT":
        add(
          {
            ...base,
            role: v("combobox"),
            name: v(el.label ?? ""),
            value: v(el.value ?? ""),
            properties: [...props, { name: "expanded", value: v(false) }],
          },
          parent.nodeId,
        );
        return;
      case "FORM":
        node = add({ ...base, role: v("form"), name: v("") }, parent.nodeId);
        kids();
        return;
      case "MAIN":
      case "NAV":
      case "SECTION":
      case "HEADER":
      case "FOOTER": {
        const role = {
          MAIN: "main",
          NAV: "navigation",
          SECTION: "region",
          HEADER: "banner",
          FOOTER: "contentinfo",
        }[el.tag];
        node = add(
          { ...base, role: v(role), name: v(el.attrs["aria-label"] ?? "") },
          parent.nodeId,
        );
        kids();
        return;
      }
      case "UL":
        node = add({ ...base, role: v("list"), name: v("") }, parent.nodeId);
        kids();
        return;
      case "LI":
        node = add({ ...base, role: v("listitem"), name: v("") }, parent.nodeId);
        kids();
        return;
      case "TABLE":
        node = add({ ...base, role: v("table"), name: v(el.text ?? "") }, parent.nodeId);
        kids();
        return;
      case "TR":
        node = add({ ...base, role: v("row"), name: v("") }, parent.nodeId);
        kids();
        return;
      case "TH":
      case "TD":
        node = add(
          { ...base, role: v(el.tag === "TH" ? "columnheader" : "cell"), name: v(el.text ?? "") },
          parent.nodeId,
        );
        text(el.text ?? "", node);
        return;
      case "IFRAME":
        add({ ...base, role: v("Iframe"), name: v(el.attrs.title ?? "") }, parent.nodeId);
        return;
      case "CANVAS":
        add({ ...base, role: v("Canvas"), name: v("") }, parent.nodeId);
        return;
      case "IMG":
        add({ ...base, role: v("image"), name: v(el.attrs.alt ?? "") }, parent.nodeId);
        return;
      case "DIV":
        node = add({ ...base, role: v("generic"), name: v("") }, parent.nodeId);
        if (el.text !== undefined) text(el.text, node);
        return;
      default:
        kids();
    }
  };
  for (const c of doc.root.children) walk(c, root);
  return nodes;
}

function domSnapshot(doc: MockDoc): CaptureSnapshotResult {
  const strings: string[] = [];
  const s = (x: string) => {
    let i = strings.indexOf(x);
    if (i === -1) {
      i = strings.length;
      strings.push(x);
    }
    return i;
  };
  const documents: DocumentSnapshot[] = [];
  const addDoc = (d: MockDoc): number => {
    const index = documents.length;
    const ds: DocumentSnapshot = {
      documentURL: s(d.url),
      title: s(d.title),
      frameId: s(d.frameId),
      nodes: {
        parentIndex: [],
        nodeType: [],
        nodeName: [],
        backendNodeId: [],
        attributes: [],
        inputValue: { index: [], value: [] },
        inputChecked: { index: [] },
        contentDocumentIndex: { index: [], value: [] },
        isClickable: { index: [] },
      },
      layout: { nodeIndex: [], bounds: [] },
    };
    documents.push(ds);
    const n = ds.nodes;
    const childDocs: [number, MockDoc][] = [];
    const walk = (el: MockEl, parentIndex: number) => {
      const i = n.backendNodeId?.length ?? 0;
      n.parentIndex?.push(parentIndex);
      n.nodeType?.push(el.tag === "#document" ? 9 : 1);
      n.nodeName?.push(s(el.tag));
      n.backendNodeId?.push(el.id);
      n.attributes?.push(Object.entries(el.attrs).flatMap(([k, v]) => [s(k), s(v)]));
      if (el.value !== undefined && (el.tag === "INPUT" || el.tag === "SELECT")) {
        n.inputValue?.index.push(i);
        n.inputValue?.value.push(s(el.value));
      }
      if (el.checked === true) n.inputChecked?.index.push(i);
      if (el.clickable) n.isClickable?.index.push(i);
      if (el.box !== undefined) {
        ds.layout.nodeIndex.push(i);
        const b = el.box;
        ds.layout.bounds.push([b.x * DPR, b.y * DPR, b.width * DPR, b.height * DPR]);
      }
      // Same-process (same-origin) frames are part of the snapshot; OOPIFs are not.
      if (el.frame !== undefined && !el.frame.crossOrigin) childDocs.push([i, el.frame]);
      for (const c of el.children) walk(c, i);
    };
    walk(d.root, -1);
    for (const [i, child] of childDocs) {
      const ci = addDoc(child);
      n.contentDocumentIndex?.index.push(i);
      n.contentDocumentIndex?.value.push(ci);
    }
    return index;
  };
  addDoc(doc);
  return { documents, strings };
}
