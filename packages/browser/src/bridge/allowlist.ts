/**
 * CDP method allowlist for the browser bridge (spike 01, amendment 4). The desktop enforces it
 * as defense in depth below the Gateway's `BrowserDriver`, because the socket otherwise grants
 * full CDP over the user's logged-in profile. The Gateway-side target checks the same list
 * before sending, so a bug in the driver fails here first. S11 imports this module (or its
 * protocol copy once proposed) rather than keeping its own list.
 *
 * Changes against the spike's list, each needed by a driver feature:
 * `Page.reload` / `getNavigationHistory` / `navigateToHistoryEntry` (back, forward, reload),
 * `Page.stopLoading` (blocking a redirect hop), `Page.handleJavaScriptDialog` (dialogs),
 * `Page.screencastFrameAck` (screencast flow control), `DOM.setFileInputFiles` (upload from the
 * Library), and `Runtime.callFunctionOn` limited to objects resolved in a bridge-created
 * isolated world (the fixed `<select>` and download helpers), and a narrow `Fetch` exception:
 * the driver pauses top-level *document* requests at the request stage and either continues
 * them unmodified or fails them, so an origin outside the task's set is blocked before the
 * request leaves (redirect hops included). No rewriting, no responses, no auth.
 */

export const CDP_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.queryAXTree",
  "Accessibility.enable",
  "Accessibility.disable",
  "DOM.enable",
  "DOM.disable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.getBoxModel",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "DOM.resolveNode",
  "DOM.setFileInputFiles",
  "DOMSnapshot.captureSnapshot",
  "Page.enable",
  "Page.disable",
  "Page.navigate",
  "Page.reload",
  "Page.stopLoading",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.createIsolatedWorld",
  "Page.handleJavaScriptDialog",
  "Page.captureScreenshot",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Network.enable",
  "Network.disable",
  "Runtime.enable",
  "Runtime.disable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.failRequest",
]);

/** Explicitly denied even if a wildcard rule is added later (spike 01 deny list). */
export const CDP_DENIED_PREFIXES = [
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.getResponseBody",
  "Storage.",
  "Target.",
  "Browser.",
  "Debugger.",
  "Fetch.fulfillRequest",
  "Fetch.continueResponse",
  "Fetch.continueWithAuth",
  "Fetch.getResponseBody",
  "Fetch.takeResponseBodyAsStream",
  "Page.setDownloadBehavior",
  "Browser.setDownloadBehavior",
  "Emulation.setUserAgentOverride",
  "Security.",
  "ServiceWorker.",
  "IndexedDB.",
  "CacheStorage.",
];

export interface IsolatedWorldState {
  /** Execution contexts the bridge created through `Page.createIsolatedWorld`. */
  contexts: Set<number>;
  /** Remote object ids `DOM.resolveNode` returned for one of those contexts. */
  objects: Set<string>;
}

export type CdpCheck = { ok: true } | { ok: false; reason: string };

/**
 * Check one CDP command. `world` is the desktop's per-tab isolated-world bookkeeping; the
 * Gateway side passes undefined and gets the method-name check only.
 */
export function checkCdpCommand(
  method: string,
  params: Record<string, unknown> | undefined,
  world?: IsolatedWorldState,
): CdpCheck {
  if (CDP_DENIED_PREFIXES.some((p) => method === p || (p.endsWith(".") && method.startsWith(p)))) {
    return { ok: false, reason: `${method} is denied on the bridge` };
  }
  if (!CDP_ALLOWED_METHODS.has(method)) {
    return { ok: false, reason: `${method} is not on the bridge allowlist` };
  }
  const fetchCheck = checkFetch(method, params);
  if (fetchCheck !== undefined) return fetchCheck;
  if (world === undefined) return { ok: true };
  if (method === "Runtime.evaluate") {
    const ctx = params?.contextId;
    if (typeof ctx !== "number" || !world.contexts.has(ctx)) {
      return { ok: false, reason: "Runtime.evaluate is allowed only in a bridge isolated world" };
    }
  }
  if (method === "Runtime.callFunctionOn") {
    const obj = params?.objectId;
    if (typeof obj !== "string" || !world.objects.has(obj)) {
      return {
        ok: false,
        reason: "Runtime.callFunctionOn is allowed only on isolated-world objects",
      };
    }
  }
  if (method === "DOM.resolveNode") {
    const ctx = params?.executionContextId;
    if (typeof ctx !== "number" || !world.contexts.has(ctx)) {
      return { ok: false, reason: "DOM.resolveNode needs a bridge isolated-world context" };
    }
  }
  return { ok: true };
}

/** `Fetch.*` may only pause documents at the request stage and continue them unmodified. */
function checkFetch(
  method: string,
  params: Record<string, unknown> | undefined,
): CdpCheck | undefined {
  if (method === "Fetch.enable") {
    if (params?.handleAuthRequests === true)
      return { ok: false, reason: "Fetch auth handling is denied" };
    const patterns = params?.patterns;
    const ok =
      Array.isArray(patterns) &&
      patterns.length > 0 &&
      patterns.every(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          (p as Record<string, unknown>).resourceType === "Document" &&
          ((p as Record<string, unknown>).requestStage ?? "Request") === "Request",
      );
    return ok ? { ok: true } : { ok: false, reason: "Fetch.enable only for Document requests" };
  }
  if (method === "Fetch.continueRequest") {
    const keys = Object.keys(params ?? {});
    return keys.every((k) => k === "requestId")
      ? { ok: true }
      : { ok: false, reason: "Fetch.continueRequest may not modify the request" };
  }
  if (method === "Fetch.failRequest") {
    const keys = Object.keys(params ?? {});
    return keys.every((k) => k === "requestId" || k === "errorReason")
      ? { ok: true }
      : { ok: false, reason: "Fetch.failRequest takes requestId and errorReason only" };
  }
  return undefined;
}
