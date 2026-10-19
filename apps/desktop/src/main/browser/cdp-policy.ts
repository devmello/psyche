/**
 * CDP method allowlist for agent tabs (spike 01 amendment 4, security §6).
 *
 * Defense in depth below the Gateway's `BrowserDriver`: the bridge socket would otherwise grant
 * full CDP over the user's logged-in profile. Pure: no Electron import, one instance per tab.
 *
 * Page JavaScript is only allowed inside isolated worlds the bridge itself created
 * (`Page.createIsolatedWorld`), so the agent can read the DOM without page code observing or
 * lying to it, and can never run script in the page's main world. Context ids are recorded from
 * the RESULT of `Page.createIsolatedWorld` (never from `Runtime.executionContextCreated`, which
 * also reports main-world contexts) and object ids only when they were minted inside one of those
 * contexts.
 *
 * Execution context ids are unique per renderer process, not globally: after a cross-process
 * navigation a new main-world context may reuse an old isolated-world id. The host therefore calls
 * `reset()` on every main-frame cross-document navigation start and on renderer crashes, which
 * works even when the Gateway never enabled the Page or Runtime domains. `generation` lets the host
 * drop `Page.createIsolatedWorld` results that were in flight across such a reset.
 */

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

type Params = Record<string, unknown> | undefined;

/** Whole domains whose every method is allowed. */
const ALLOWED_DOMAINS = new Set(["Accessibility"]);

/** Methods allowed without parameter checks. */
const ALLOWED_METHODS = new Set([
  // DOM: read and focus only. No DOM.set*, DOM.remove*, DOM.setFileInputFiles.
  "DOM.enable",
  "DOM.disable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.resolveNode",
  "DOM.requestNode",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "DOM.getAttributes",
  "DOM.getOuterHTML",
  "DOM.pushNodesByBackendIdsToFrontend",
  "DOM.getFrameOwner",
  "DOMSnapshot.enable",
  "DOMSnapshot.disable",
  "DOMSnapshot.captureSnapshot",
  // Page: Page.navigate is checked separately (http and https only).
  "Page.enable",
  "Page.disable",
  "Page.reload",
  "Page.stopLoading",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Runtime.enable",
  "Runtime.disable",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
  "Network.enable",
  "Network.disable",
  "Emulation.setFocusEmulationEnabled",
  "Overlay.enable",
  "Overlay.disable",
  "Overlay.highlightRect",
  "Overlay.hideHighlight",
]);

/**
 * Input methods refused even though `Input.*` is otherwise allowed:
 * - `setIgnoreInputEvents` would lock the user out of their own tab (Take control).
 * `Input.dispatchDragEvent` is checked separately: `data.files` would drop local files on a page.
 */
const DENIED_INPUT = new Set([
  "Input.setIgnoreInputEvents",
  "Input.setInterceptDrags",
  // Long-running synthesized gestures hold the agent-input depth up and would keep the user's
  // clicks from taking control; agents dispatch individual mouse/touch events instead.
  "Input.synthesizeScrollGesture",
  "Input.synthesizeTapGesture",
  "Input.synthesizePinchGesture",
]);

/**
 * Editor commands `Input.dispatchKeyEvent` may carry. Clipboard commands (paste, copy, cut) are
 * refused: pasting would hand the user's clipboard (a password just copied) to the page.
 */
const KEY_COMMAND_OK =
  /^(selectAll|undo|redo|delete[A-Za-z]*|move[A-Za-z]*|insertNewline|insertTab|insertLineBreak|insertBacktab|scroll[A-Za-z]*)$/;

/** Parameters each allowed method may carry beyond its own; anything else is refused. */
const PARAM_RULES: Record<string, (p: Record<string, unknown>) => string | null> = {
  // scriptToEvaluateOnLoad would inject main-world script into every frame after the reload.
  "Page.reload": (p) =>
    Object.keys(p).every((k) => k === "ignoreCache" || k === "loaderId")
      ? null
      : "Page.reload accepts only ignoreCache",
  // grantUniveralAccess (sic, CDP's spelling) loosens same-origin checks inside the world.
  "Page.createIsolatedWorld": (p) =>
    p.grantUniveralAccess === true || p.grantUniversalAccess === true
      ? "isolated worlds with universal access are not allowed"
      : null,
};

/** Methods that change the page; refused (like Input.*) while the user holds the tab. */
export const PAGE_MUTATING = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.stopLoading",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
]);

export function isAgentActionMethod(method: string): boolean {
  return method.startsWith("Input.") || PAGE_MUTATING.has(method);
}

const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);

function redactHeaders(h: unknown): unknown {
  if (!isRecord(h)) return h;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h))
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
  return out;
}

/**
 * Filters a CDP event before it leaves the desktop. Network events would otherwise carry every
 * cookie (HttpOnly included) and Authorization header of the logged-in profile, which the
 * allowlist already refuses to return through Network.getCookies. Returns null to drop.
 */
export function filterCdpEvent(method: string, params: unknown): unknown | null {
  if (!method.startsWith("Network.")) return params;
  if (method.endsWith("ExtraInfo")) return null;
  if (!isRecord(params)) return params;
  const p: Record<string, unknown> = { ...params };
  for (const key of ["request", "response"]) {
    const part = p[key];
    if (isRecord(part)) {
      p[key] = {
        ...part,
        ...(part.headers !== undefined ? { headers: redactHeaders(part.headers) } : {}),
        ...(part.requestHeaders !== undefined
          ? { requestHeaders: redactHeaders(part.requestHeaders) }
          : {}),
        ...(part.headersText !== undefined ? { headersText: "[redacted]" } : {}),
        ...(part.requestHeadersText !== undefined ? { requestHeadersText: "[redacted]" } : {}),
      };
    }
  }
  if (isRecord(p.redirectResponse)) {
    const r = p.redirectResponse;
    p.redirectResponse = {
      ...r,
      headers: redactHeaders(r.headers),
      ...(r.requestHeaders !== undefined
        ? { requestHeaders: redactHeaders(r.requestHeaders) }
        : {}),
      ...(r.headersText !== undefined ? { headersText: "[redacted]" } : {}),
      ...(r.requestHeadersText !== undefined ? { requestHeadersText: "[redacted]" } : {}),
    };
  }
  return p;
}

/**
 * Domains named here are denied wholesale; listed for the reason text only (everything not
 * allowed is denied anyway). `Target.setAutoAttach` is denied too, so cross-origin iframes
 * (OOPIFs) are not reachable yet: supporting them (flattened child sessions with their own
 * isolated worlds) is a follow-up.
 */
const DENIED_DOMAINS: Record<string, string> = {
  Storage: "storage access is not allowed",
  Target: "Target.* is not allowed (OOPIF auto-attach is a follow-up)",
  Browser: "Browser.* is not allowed",
  Debugger: "Debugger.* is not allowed",
  Fetch: "request interception is not allowed",
};

const BLOCKED_SCHEMES =
  /^(about|chrome|chrome-extension|devtools|file|data|javascript|blob|view-source):/i;

interface SessionState {
  /** Isolated-world execution context id → frame id it was created in. */
  contexts: Map<number, string>;
  /** Remote object id → execution context id it lives in. */
  objects: Map<string, number>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deny(reason: string): PolicyDecision {
  return { ok: false, reason };
}

const OK: PolicyDecision = { ok: true };

/** Allows `http:` and `https:` URLs without userinfo. */
export function isAllowedNavigationUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || BLOCKED_SCHEMES.test(raw.trim())) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.username === "" && url.password === "";
}

export class CdpPolicy {
  private readonly sessions = new Map<string, SessionState>();
  private gen = 0;

  /** Bumped by every `reset()`; pass the value read before sending to `observeResult`. */
  get generation(): number {
    return this.gen;
  }

  /** True when `contextId` is a bridge-created isolated world in that session. */
  hasContext(contextId: number, sessionId?: string): boolean {
    return this.sessions.get(sessionId ?? "")?.contexts.has(contextId) ?? false;
  }

  /** True when `objectId` was minted inside a bridge-created isolated world. */
  hasObject(objectId: string, sessionId?: string): boolean {
    return this.sessions.get(sessionId ?? "")?.objects.has(objectId) ?? false;
  }

  check(method: string, params: Params, sessionId?: string): PolicyDecision {
    const dot = method.indexOf(".");
    if (dot <= 0) return deny(`${method} is not a CDP method`);
    const domain = method.slice(0, dot);
    const rule = PARAM_RULES[method];
    if (rule) {
      const reason = rule(isRecord(params) ? params : {});
      if (reason) return deny(reason);
    }
    if (ALLOWED_DOMAINS.has(domain)) return OK;
    if (ALLOWED_METHODS.has(method)) return OK;
    if (domain === "Input") {
      if (DENIED_INPUT.has(method)) return deny(`${method} is not allowed`);
      if (method === "Input.dispatchKeyEvent") {
        const cmds = isRecord(params) ? params.commands : undefined;
        if (cmds !== undefined) {
          if (
            !Array.isArray(cmds) ||
            !cmds.every((c) => typeof c === "string" && KEY_COMMAND_OK.test(c))
          )
            return deny("clipboard and unknown editor commands are not allowed");
        }
      }
      if (method === "Input.dispatchDragEvent") {
        const data = isRecord(params) ? params.data : undefined;
        if (isRecord(data) && Array.isArray(data.files) && data.files.length > 0)
          return deny("dragging local files into a page is not allowed");
      }
      return OK;
    }
    if (method === "Page.navigate") {
      const url = isRecord(params) ? params.url : undefined;
      return isAllowedNavigationUrl(url)
        ? OK
        : deny("Page.navigate is limited to http and https URLs");
    }
    if (method === "Runtime.evaluate") return this.checkEvaluate(params, sessionId);
    if (method === "Runtime.callFunctionOn") return this.checkCallFunctionOn(params, sessionId);
    const domainReason = DENIED_DOMAINS[domain];
    if (domainReason !== undefined) return deny(domainReason);
    return deny(`${method} is not in the bridge allowlist`);
  }

  private checkEvaluate(params: Params, sessionId: string | undefined): PolicyDecision {
    if (!isRecord(params)) return deny("Runtime.evaluate needs a contextId");
    if (params.uniqueContextId !== undefined)
      return deny("Runtime.evaluate with uniqueContextId is not allowed; use contextId");
    const ctx = params.contextId;
    if (typeof ctx !== "number") return deny("Runtime.evaluate in the main world is not allowed");
    if (!this.hasContext(ctx, sessionId))
      return deny("Runtime.evaluate is limited to bridge-created isolated worlds");
    return OK;
  }

  private checkCallFunctionOn(params: Params, sessionId: string | undefined): PolicyDecision {
    if (!isRecord(params)) return deny("Runtime.callFunctionOn needs a target");
    if (params.uniqueContextId !== undefined)
      return deny("Runtime.callFunctionOn with uniqueContextId is not allowed");
    const ctx = params.executionContextId;
    const obj = params.objectId;
    if (ctx === undefined && obj === undefined)
      return deny("Runtime.callFunctionOn needs an executionContextId or objectId");
    if (ctx !== undefined && (typeof ctx !== "number" || !this.hasContext(ctx, sessionId)))
      return deny("Runtime.callFunctionOn is limited to bridge-created isolated worlds");
    if (obj !== undefined && (typeof obj !== "string" || !this.hasObject(obj, sessionId)))
      return deny("Runtime.callFunctionOn objectId was not minted in an isolated world");
    const args = params.arguments;
    if (args !== undefined) {
      if (!Array.isArray(args)) return deny("Runtime.callFunctionOn arguments must be an array");
      for (const a of args) {
        if (!isRecord(a) || a.objectId === undefined) continue;
        if (typeof a.objectId !== "string" || !this.hasObject(a.objectId, sessionId))
          return deny(
            "Runtime.callFunctionOn argument objectId was not minted in an isolated world",
          );
      }
    }
    return OK;
  }

  /**
   * Records ids from a successful command result. `generation` is `this.generation` as read
   * before the command was sent; results that straddle a `reset()` are ignored.
   */
  observeResult(
    method: string,
    params: Params,
    result: unknown,
    options: { sessionId?: string; generation?: number } = {},
  ): void {
    if (options.generation !== undefined && options.generation !== this.gen) return;
    if (!isRecord(result)) return;
    const sessionId = options.sessionId;
    switch (method) {
      case "Page.createIsolatedWorld": {
        const id = result.executionContextId;
        const frameId =
          isRecord(params) && typeof params.frameId === "string" ? params.frameId : "";
        if (typeof id === "number") this.session(sessionId).contexts.set(id, frameId);
        return;
      }
      case "Runtime.evaluate": {
        const ctx = isRecord(params) ? params.contextId : undefined;
        if (typeof ctx === "number" && this.hasContext(ctx, sessionId))
          this.recordObject(result.result, ctx, sessionId);
        return;
      }
      case "Runtime.callFunctionOn": {
        if (!isRecord(params)) return;
        let ctx: number | undefined;
        if (typeof params.executionContextId === "number") ctx = params.executionContextId;
        else if (typeof params.objectId === "string")
          ctx = this.sessions.get(sessionId ?? "")?.objects.get(params.objectId);
        if (ctx !== undefined && this.hasContext(ctx, sessionId))
          this.recordObject(result.result, ctx, sessionId);
        return;
      }
      case "DOM.resolveNode": {
        const ctx = isRecord(params) ? params.executionContextId : undefined;
        if (typeof ctx === "number" && this.hasContext(ctx, sessionId))
          this.recordObject(result.object, ctx, sessionId);
        return;
      }
      case "Runtime.releaseObject": {
        const obj = isRecord(params) ? params.objectId : undefined;
        if (typeof obj === "string") this.sessions.get(sessionId ?? "")?.objects.delete(obj);
        return;
      }
      default:
        return;
    }
  }

  /** Forgets contexts (and their objects) that CDP reports as gone. */
  observeEvent(method: string, params: unknown, sessionId?: string): void {
    const s = this.sessions.get(sessionId ?? "");
    if (s === undefined) return;
    switch (method) {
      case "Runtime.executionContextDestroyed": {
        if (!isRecord(params)) return;
        const id = params.executionContextId;
        if (typeof id === "number") this.dropContext(s, id);
        return;
      }
      case "Runtime.executionContextsCleared":
        this.clearSession(s);
        return;
      case "Page.frameNavigated": {
        const frame = isRecord(params) ? params.frame : undefined;
        if (!isRecord(frame)) return;
        if (frame.parentId === undefined) {
          this.clearSession(s);
          return;
        }
        if (typeof frame.id === "string") this.dropFrame(s, frame.id);
        return;
      }
      case "Page.frameDetached": {
        if (isRecord(params) && typeof params.frameId === "string")
          this.dropFrame(s, params.frameId);
        return;
      }
      default:
        return;
    }
  }

  /** Forgets everything (main-frame navigation, renderer crash, debugger detach). */
  reset(): void {
    this.sessions.clear();
    this.gen++;
  }

  private session(sessionId: string | undefined): SessionState {
    const key = sessionId ?? "";
    let s = this.sessions.get(key);
    if (s === undefined) {
      s = { contexts: new Map(), objects: new Map() };
      this.sessions.set(key, s);
    }
    return s;
  }

  private recordObject(remote: unknown, ctx: number, sessionId: string | undefined): void {
    if (!isRecord(remote) || typeof remote.objectId !== "string") return;
    this.session(sessionId).objects.set(remote.objectId, ctx);
  }

  private dropContext(s: SessionState, id: number): void {
    s.contexts.delete(id);
    for (const [obj, ctx] of s.objects) if (ctx === id) s.objects.delete(obj);
  }

  private dropFrame(s: SessionState, frameId: string): void {
    for (const [ctx, frame] of s.contexts) if (frame === frameId) this.dropContext(s, ctx);
  }

  private clearSession(s: SessionState): void {
    s.contexts.clear();
    s.objects.clear();
  }
}
