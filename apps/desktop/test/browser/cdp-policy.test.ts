import { describe, expect, it } from "vitest";
import {
  CdpPolicy,
  filterCdpEvent,
  isAgentActionMethod,
  isAllowedNavigationUrl,
} from "../../src/main/browser/cdp-policy.ts";

function allowed(p: CdpPolicy, method: string, params?: Record<string, unknown>, sid?: string) {
  return p.check(method, params, sid).ok;
}

/** Creates an isolated world through the policy as the host would and returns its context id. */
function world(p: CdpPolicy, id: number, frameId = "main", sid?: string): number {
  const params = { frameId, worldName: "psyche" };
  expect(p.check("Page.createIsolatedWorld", params, sid).ok).toBe(true);
  p.observeResult(
    "Page.createIsolatedWorld",
    params,
    { executionContextId: id },
    { sessionId: sid },
  );
  return id;
}

const fn = "function(){return this.value}";

describe("CdpPolicy allowlist", () => {
  const p = new CdpPolicy();

  it.each([
    "Accessibility.getFullAXTree",
    "Accessibility.queryAXTree",
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
    "DOM.enable",
    "DOM.disable",
    "DOM.getAttributes",
    "DOM.getOuterHTML",
    "DOM.pushNodesByBackendIdsToFrontend",
    "DOM.getFrameOwner",
    "DOMSnapshot.captureSnapshot",
    "DOMSnapshot.enable",
    "DOMSnapshot.disable",
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
    "Page.enable",
    "Page.disable",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Input.dispatchDragEvent",
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
  ])("allows %s", (method) => {
    expect(p.check(method, {})).toEqual({ ok: true });
  });

  it.each([
    "Network.getCookies",
    "Network.getAllCookies",
    "Network.setCookie",
    "Network.setCookies",
    "Network.clearBrowserCookies",
    "Network.getResponseBody",
    "Storage.getCookies",
    "Storage.clearDataForOrigin",
    "Target.setAutoAttach",
    "Target.createTarget",
    "Target.attachToTarget",
    "Browser.close",
    "Browser.grantPermissions",
    "Debugger.enable",
    "Debugger.evaluateOnCallFrame",
    // Bare: no document-only patterns, so it would intercept everything.
    "Fetch.enable",
    "Fetch.fulfillRequest",
    "Page.setDownloadBehavior",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.printToPDF",
    "DOM.setFileInputFiles",
    "DOM.setAttributeValue",
    "DOM.setOuterHTML",
    "DOM.setNodeValue",
    "DOM.removeNode",
    "DOM.removeAttribute",
    "Runtime.compileScript",
    "Runtime.runScript",
    "Runtime.getProperties",
    "Runtime.addBinding",
    "Emulation.setUserAgentOverride",
    "Security.setIgnoreCertificateErrors",
    "Input.setIgnoreInputEvents",
    "IO.read",
  ])("denies %s", (method) => {
    const d = p.check(method, {});
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason.length).toBeGreaterThan(0);
  });

  it("denies a drag that carries local files", () => {
    const base = { type: "drop", x: 1, y: 1 };
    expect(
      allowed(p, "Input.dispatchDragEvent", {
        ...base,
        data: { items: [], files: ["/etc/passwd"], dragOperationsMask: 1 },
      }),
    ).toBe(false);
    expect(
      allowed(p, "Input.dispatchDragEvent", {
        ...base,
        data: { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 },
      }),
    ).toBe(true);
  });

  it("denies method names without a domain", () => {
    expect(p.check("evaluate", {}).ok).toBe(false);
  });
});

describe("Page.navigate", () => {
  const p = new CdpPolicy();

  it.each(["https://example.com/", "http://localhost:3000/a?b=c", "HTTPS://EXAMPLE.COM"])(
    "allows %s",
    (url) => {
      expect(allowed(p, "Page.navigate", { url })).toBe(true);
    },
  );

  it.each([
    "about:blank",
    "chrome://settings",
    "chrome-extension://abc/x.html",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "javascript:alert(1)",
    " javascript:alert(1)",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "blob:https://example.com/123",
    "ftp://example.com",
    "https://user:pw@example.com/",
    "not a url",
  ])("denies %s", (url) => {
    expect(allowed(p, "Page.navigate", { url })).toBe(false);
  });

  it("denies a missing or non-string url", () => {
    expect(allowed(p, "Page.navigate", {})).toBe(false);
    expect(allowed(p, "Page.navigate", { url: 42 })).toBe(false);
    expect(allowed(p, "Page.navigate")).toBe(false);
    expect(isAllowedNavigationUrl(undefined)).toBe(false);
  });
});

describe("isolated worlds", () => {
  it("denies main-world Runtime.evaluate", () => {
    const p = new CdpPolicy();
    expect(allowed(p, "Runtime.evaluate", { expression: "document.cookie" })).toBe(false);
    expect(allowed(p, "Runtime.evaluate")).toBe(false);
    // A context the bridge never created (the main world's, from executionContextCreated).
    p.observeEvent("Runtime.executionContextCreated", { context: { id: 1 } });
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: 1 })).toBe(false);
  });

  it("allows Runtime.evaluate in a bridge-created world, never via uniqueContextId", () => {
    const p = new CdpPolicy();
    const ctx = world(p, 7);
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: ctx })).toBe(true);
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: 8 })).toBe(false);
    expect(allowed(p, "Runtime.evaluate", { expression: "1", uniqueContextId: "abc" })).toBe(false);
    expect(
      allowed(p, "Runtime.evaluate", { expression: "1", contextId: ctx, uniqueContextId: "x" }),
    ).toBe(false);
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: "7" })).toBe(false);
  });

  it("ignores failed or malformed createIsolatedWorld results", () => {
    const p = new CdpPolicy();
    p.observeResult("Page.createIsolatedWorld", { frameId: "f" }, null);
    p.observeResult("Page.createIsolatedWorld", { frameId: "f" }, { executionContextId: "9" });
    expect(p.hasContext(9)).toBe(false);
  });

  it("forgets contexts on destroy, clear and navigation", () => {
    const p = new CdpPolicy();
    world(p, 1);
    world(p, 2);
    p.observeEvent("Runtime.executionContextDestroyed", { executionContextId: 1 });
    expect(p.hasContext(1)).toBe(false);
    expect(p.hasContext(2)).toBe(true);
    p.observeEvent("Runtime.executionContextsCleared", {});
    expect(p.hasContext(2)).toBe(false);

    world(p, 3, "main");
    world(p, 4, "child");
    p.observeEvent("Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
    expect(p.hasContext(4)).toBe(false);
    expect(p.hasContext(3)).toBe(true);
    world(p, 5, "child");
    p.observeEvent("Page.frameDetached", { frameId: "child" });
    expect(p.hasContext(5)).toBe(false);
    p.observeEvent("Page.frameNavigated", { frame: { id: "main", loaderId: "L2" } });
    expect(p.hasContext(3)).toBe(false);
  });

  it("reset() forgets everything and drops results that straddle it", () => {
    const p = new CdpPolicy();
    world(p, 1);
    const gen = p.generation;
    p.reset();
    expect(p.hasContext(1)).toBe(false);
    const params = { frameId: "main" };
    p.observeResult(
      "Page.createIsolatedWorld",
      params,
      { executionContextId: 2 },
      { generation: gen },
    );
    expect(p.hasContext(2)).toBe(false);
    p.observeResult(
      "Page.createIsolatedWorld",
      params,
      { executionContextId: 3 },
      { generation: p.generation },
    );
    expect(p.hasContext(3)).toBe(true);
  });

  it("keeps CDP sessions apart", () => {
    const p = new CdpPolicy();
    world(p, 5, "main", "S1");
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: 5 }, "S1")).toBe(true);
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: 5 })).toBe(false);
    expect(allowed(p, "Runtime.evaluate", { expression: "1", contextId: 5 }, "S2")).toBe(false);
  });
});

describe("Runtime.callFunctionOn", () => {
  it("requires an allowed context or a minted object", () => {
    const p = new CdpPolicy();
    expect(allowed(p, "Runtime.callFunctionOn", { functionDeclaration: fn })).toBe(false);
    expect(
      allowed(p, "Runtime.callFunctionOn", { functionDeclaration: fn, executionContextId: 1 }),
    ).toBe(false);
    const ctx = world(p, 1);
    expect(
      allowed(p, "Runtime.callFunctionOn", { functionDeclaration: fn, executionContextId: ctx }),
    ).toBe(true);
    expect(
      allowed(p, "Runtime.callFunctionOn", {
        functionDeclaration: fn,
        executionContextId: ctx,
        uniqueContextId: "u",
      }),
    ).toBe(false);
  });

  it("tracks objects minted by evaluate, callFunctionOn and resolveNode in isolated worlds", () => {
    const p = new CdpPolicy();
    const ctx = world(p, 1);
    p.observeResult(
      "Runtime.evaluate",
      { expression: "document.body", contextId: ctx },
      { result: { type: "object", objectId: "obj-eval" } },
    );
    p.observeResult(
      "DOM.resolveNode",
      { backendNodeId: 12, executionContextId: ctx },
      { object: { type: "object", objectId: "obj-node" } },
    );
    p.observeResult(
      "Runtime.callFunctionOn",
      { functionDeclaration: fn, objectId: "obj-node" },
      { result: { type: "object", objectId: "obj-call" } },
    );
    for (const objectId of ["obj-eval", "obj-node", "obj-call"]) {
      expect(allowed(p, "Runtime.callFunctionOn", { functionDeclaration: fn, objectId })).toBe(
        true,
      );
    }
  });

  it("never trusts objects from the main world", () => {
    const p = new CdpPolicy();
    const ctx = world(p, 1);
    // DOM.resolveNode without executionContextId resolves into the main world.
    p.observeResult(
      "DOM.resolveNode",
      { backendNodeId: 12 },
      { object: { type: "object", objectId: "main-node" } },
    );
    p.observeResult(
      "Runtime.evaluate",
      { expression: "window" },
      { result: { type: "object", objectId: "main-win" } },
    );
    for (const objectId of ["main-node", "main-win"]) {
      expect(allowed(p, "Runtime.callFunctionOn", { functionDeclaration: fn, objectId })).toBe(
        false,
      );
    }
    const call = (args: unknown) =>
      allowed(p, "Runtime.callFunctionOn", {
        functionDeclaration: fn,
        executionContextId: ctx,
        arguments: args,
      });
    expect(call([{ objectId: "main-node" }])).toBe(false);
    expect(call([{ value: 1 }])).toBe(true);
    expect(call("nope")).toBe(false);
  });

  it("forgets objects with their context and on releaseObject", () => {
    const p = new CdpPolicy();
    const ctx = world(p, 1);
    const mint = (objectId: string) =>
      p.observeResult(
        "Runtime.evaluate",
        { expression: "x", contextId: ctx },
        { result: { type: "object", objectId } },
      );
    mint("a");
    mint("b");
    p.observeResult("Runtime.releaseObject", { objectId: "a" }, {});
    expect(p.hasObject("a")).toBe(false);
    expect(p.hasObject("b")).toBe(true);
    p.observeEvent("Runtime.executionContextDestroyed", { executionContextId: ctx });
    expect(p.hasObject("b")).toBe(false);
  });

  it("rejects an allowed objectId paired with a foreign executionContextId", () => {
    const p = new CdpPolicy();
    const ctx = world(p, 1);
    p.observeResult(
      "Runtime.evaluate",
      { expression: "x", contextId: ctx },
      { result: { type: "object", objectId: "o" } },
    );
    expect(
      allowed(p, "Runtime.callFunctionOn", {
        functionDeclaration: fn,
        objectId: "o",
        executionContextId: 99,
      }),
    ).toBe(false);
  });
});

describe("review hardening", () => {
  it("refuses main-world script smuggled through Page.reload and universal-access worlds", () => {
    const p = new CdpPolicy();
    expect(p.check("Page.reload", { ignoreCache: true }).ok).toBe(true);
    expect(p.check("Page.reload", {}).ok).toBe(true);
    expect(p.check("Page.reload", { scriptToEvaluateOnLoad: "steal()" }).ok).toBe(false);
    expect(p.check("Page.createIsolatedWorld", { frameId: "F", worldName: "w" }).ok).toBe(true);
    expect(
      p.check("Page.createIsolatedWorld", { frameId: "F", grantUniveralAccess: true }).ok,
    ).toBe(false);
  });

  it("refuses clipboard editor commands and long synthesized gestures", () => {
    const p = new CdpPolicy();
    expect(p.check("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }).ok).toBe(true);
    expect(p.check("Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"] }).ok).toBe(
      true,
    );
    for (const c of ["paste", "Paste", "copy", "cut", "pasteAndMatchStyle"])
      expect(p.check("Input.dispatchKeyEvent", { type: "keyDown", commands: [c] }).ok, c).toBe(
        false,
      );
    for (const m of [
      "Input.synthesizeScrollGesture",
      "Input.synthesizeTapGesture",
      "Input.setInterceptDrags",
    ])
      expect(p.check(m, {}).ok, m).toBe(false);
  });

  it("marks page-changing methods so they wait for the user", () => {
    expect(isAgentActionMethod("Input.insertText")).toBe(true);
    expect(isAgentActionMethod("Page.navigate")).toBe(true);
    expect(isAgentActionMethod("Runtime.callFunctionOn")).toBe(true);
    expect(isAgentActionMethod("Accessibility.getFullAXTree")).toBe(false);
    expect(isAgentActionMethod("Page.captureScreenshot")).toBe(false);
  });

  it("drops ExtraInfo network events and redacts cookies and auth headers", () => {
    expect(
      filterCdpEvent("Network.requestWillBeSentExtraInfo", { headers: { Cookie: "sid=1" } }),
    ).toBeNull();
    expect(
      filterCdpEvent("Network.responseReceivedExtraInfo", { headers: { "Set-Cookie": "x" } }),
    ).toBeNull();
    const sent = filterCdpEvent("Network.requestWillBeSent", {
      request: {
        url: "https://acme.com",
        headers: { Cookie: "sid=1", Authorization: "Bearer t", Accept: "*/*" },
      },
      redirectResponse: { headers: { "set-cookie": "sid=2" } },
    }) as {
      request: { headers: Record<string, string> };
      redirectResponse: { headers: Record<string, string> };
    };
    expect(sent.request.headers).toEqual({
      Cookie: "[redacted]",
      Authorization: "[redacted]",
      Accept: "*/*",
    });
    expect(sent.redirectResponse.headers["set-cookie"]).toBe("[redacted]");
    const got = filterCdpEvent("Network.responseReceived", {
      response: { headers: { "Set-Cookie": "sid=3" }, headersText: "Set-Cookie: sid=3" },
    }) as { response: { headers: Record<string, string>; headersText: string } };
    expect(JSON.stringify(got)).not.toContain("sid=3");
    expect(filterCdpEvent("Page.loadEventFired", { timestamp: 1 })).toEqual({ timestamp: 1 });
  });
});

describe("narrow Fetch for document requests and Web Bot Auth (I14)", () => {
  const DOC = {
    patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
  };

  it("pauses only document requests at the request stage", () => {
    const p = new CdpPolicy();
    expect(allowed(p, "Fetch.enable", DOC)).toBe(true);
    expect(allowed(p, "Fetch.enable", {})).toBe(false);
    expect(allowed(p, "Fetch.enable", { ...DOC, handleAuthRequests: true })).toBe(false);
    expect(
      allowed(p, "Fetch.enable", {
        patterns: [{ resourceType: "Script", requestStage: "Request" }],
      }),
    ).toBe(false);
    expect(
      allowed(p, "Fetch.enable", {
        patterns: [{ resourceType: "Document", requestStage: "Response" }],
      }),
    ).toBe(false);
    expect(allowed(p, "Fetch.disable", {})).toBe(true);
    expect(
      allowed(p, "Fetch.failRequest", { requestId: "r1", errorReason: "BlockedByClient" }),
    ).toBe(true);
    for (const m of ["Fetch.fulfillRequest", "Fetch.continueResponse", "Fetch.getResponseBody"]) {
      expect(allowed(p, m, { requestId: "r1" }), m).toBe(false);
    }
  });

  it("adds only signature headers, merged into the request's real ones", () => {
    const p = new CdpPolicy();
    // The real request, cookies and all: the Gateway only ever sees a redacted copy.
    p.observeEvent("Fetch.requestPaused", {
      requestId: "r1",
      request: { url: "https://shop.example/", headers: { "User-Agent": "UA", Cookie: "sid=3" } },
    });
    const sig = [
      { name: "Signature-Agent", value: '"https://agent.example/dir"' },
      { name: "Signature-Input", value: 'sig1=("@authority" "signature-agent");created=1' },
      { name: "Signature", value: "sig1=:AAAA:" },
    ];
    expect(allowed(p, "Fetch.continueRequest", { requestId: "r1", headers: sig })).toBe(true);
    const prepared = p.prepare("Fetch.continueRequest", { requestId: "r1", headers: sig });
    expect(prepared).toEqual({
      ok: true,
      params: {
        requestId: "r1",
        headers: [{ name: "User-Agent", value: "UA" }, { name: "Cookie", value: "sid=3" }, ...sig],
      },
    });
    // Anything but signature headers, or a URL / method change, is refused.
    expect(
      allowed(p, "Fetch.continueRequest", {
        requestId: "r2",
        headers: [{ name: "Cookie", value: "x" }],
      }),
    ).toBe(false);
    expect(
      allowed(p, "Fetch.continueRequest", { requestId: "r2", url: "https://evil.example/" }),
    ).toBe(false);
    expect(
      allowed(p, "Fetch.continueRequest", {
        requestId: "r2",
        headers: [{ name: "Signature", value: "a\r\nCookie: x" }],
      }),
    ).toBe(false);
    // A request the policy never saw paused gets no headers.
    expect(p.prepare("Fetch.continueRequest", { requestId: "nope", headers: sig })).toMatchObject({
      ok: false,
    });
    // Plain continues pass through untouched.
    expect(p.prepare("Fetch.continueRequest", { requestId: "r9" })).toEqual({
      ok: true,
      params: { requestId: "r9" },
    });
  });

  it("is not an agent action, so the owner's own navigations are never held", () => {
    expect(isAgentActionMethod("Fetch.continueRequest")).toBe(false);
  });
});
