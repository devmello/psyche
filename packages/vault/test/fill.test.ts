import type { FillElement } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizedFetch,
  buildSecretEnv,
  type CdpSession,
  fillBrowserField,
  safeHttpError,
} from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

const PW = "fill-protocol-password-42";
const KEY = "x-api-key-0123456789abcdef";
let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
  await h.vault.add({
    kind: "login",
    name: "GitHub",
    bindings: [{ origin: "https://github.com" }],
    secret: { username: "pat", password: PW },
  });
  await h.vault.add({
    kind: "api_key",
    name: "Example",
    bindings: [{ host: "api.example.test" }],
    secret: { token: KEY, headerName: "X-Api-Key" },
  });
});
afterEach(() => h.cleanup());

/** A page in the agent browser, as CDP sees it. */
function fakePage(
  opts: {
    origin?: string;
    element?: FillElement | null;
    backendNodeId?: number;
    swallow?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const typed: string[] = [];
  let value = "";
  const element = opts.element === undefined ? PASSWORD_FIELD : opts.element;
  const cdp: CdpSession = {
    async send(method, params = {}) {
      calls.push(method);
      switch (method) {
        case "Page.getFrameTree":
          return {
            frameTree: {
              frame: {
                id: "F1",
                url: `${opts.origin ?? "https://github.com"}/login`,
                securityOrigin: opts.origin ?? "https://github.com",
              },
            },
          };
        case "Page.createIsolatedWorld":
          return { executionContextId: 7 };
        case "Runtime.evaluate":
          return { result: element === null ? { subtype: "null" } : { objectId: "obj1" } };
        case "DOM.describeNode":
          return { node: { backendNodeId: opts.backendNodeId ?? 42 } };
        case "Runtime.callFunctionOn": {
          const fn = String(params.functionDeclaration);
          if (fn.includes("formHasPassword")) return { result: { value: element } };
          if (fn.includes("activeElement === this"))
            return { result: { value: [...value].length } };
          if (fn.includes('this.value = ""')) value = "";
          return { result: {} };
        }
        case "Input.insertText":
          typed.push(String(params.text));
          if (opts.swallow !== true) value += String(params.text);
          return {};
        case "Input.dispatchKeyEvent":
          if (params.key === "Backspace" && params.type === "keyDown") value = "";
          return {};
        default:
          return {};
      }
    },
  };
  return { cdp, calls, typed, value: () => value };
}

describe("browser fill (G5, G6)", () => {
  const fill = async (page: ReturnType<typeof fakePage>, apr: string, extra = {}) =>
    fillBrowserField({
      cdp: page.cdp,
      broker: h.vault,
      placeholder: "{{cred:github}}",
      approvalId: apr,
      selector: "ref_7",
      backendNodeId: 42,
      ...extra,
    });
  const approve = () =>
    approveFill(h, {
      slug: "github",
      target: "https://github.com",
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });

  it("types into the focused password field and reports secureField", async () => {
    const page = fakePage();
    const r = await fill(page, await approve());
    expect(r).toEqual({ ok: true, secureField: true, origin: "https://github.com" });
    expect(page.typed).toEqual([PW]);
    expect(JSON.stringify(r)).not.toContain(PW);
  });

  it("refuses a non-matching origin without typing anything", async () => {
    const page = fakePage({
      origin: "https://github.com.evil.test",
      element: { ...PASSWORD_FIELD, frameOrigin: "https://github.com.evil.test" },
    });
    const r = await fill(page, await approve());
    expect(r).toMatchObject({ ok: false, reason: "target_mismatch" });
    expect(page.calls).not.toContain("Input.insertText");
  });

  it("refuses when focus moved, during Take control, or into a non-password field", async () => {
    expect(await fill(fakePage({ backendNodeId: 9 }), await approve())).toMatchObject({
      reason: "focus_moved",
    });
    expect(await fill(fakePage(), await approve(), { takeControlActive: true })).toMatchObject({
      reason: "take_control_active",
    });
    const textarea = fakePage({
      element: { tagName: "textarea", frameOrigin: "https://github.com" },
    });
    expect(await fill(textarea, await approve())).toMatchObject({
      ok: false,
      reason: "not_input:textarea",
    });
    expect(textarea.typed).toEqual([]);
    expect(await fill(fakePage({ element: null }), await approve())).toMatchObject({
      reason: "no_focused_element",
    });
  });

  it("clears the field when the value did not land", async () => {
    const page = fakePage({ swallow: true });
    const r = await fill(page, await approve());
    expect(r).toMatchObject({ ok: false, reason: "fill_not_verified" });
    expect(page.calls).toContain("Input.dispatchKeyEvent");
    expect(page.value()).toBe("");
  });
});

describe("connector HTTP header injection (S23 design-16)", () => {
  type Seen = { url: string; headers: Record<string, string> };
  function fakeFetch(routes: Record<string, { status: number; location?: string; body?: string }>) {
    const seen: Seen[] = [];
    const impl = (async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      if (url.includes("offline"))
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      const r = routes[url] ?? { status: 404 };
      return new Response(r.body ?? null, {
        status: r.status,
        headers: r.location === undefined ? {} : { location: r.location },
      });
    }) as typeof fetch;
    return { impl, seen };
  }
  const approve = () =>
    approveFill(h, {
      slug: "example",
      target: "https://api.example.test",
      executor: "connector",
      field: "header",
    });
  const call = async (url: string, f: ReturnType<typeof fakeFetch>) =>
    authorizedFetch({
      broker: h.vault,
      placeholder: "{{cred:example.header}}",
      approvalId: await approve(),
      url,
      headerName: "X-Api-Key",
      fetchImpl: f.impl,
    });

  it("never sends a custom auth header across a redirect to another origin", async () => {
    for (const location of [
      "https://evil.test/x",
      "http://api.example.test/v1/me",
      "https://api.example.test:8443/x",
    ]) {
      const f = fakeFetch({ "https://api.example.test/v1/me": { status: 307, location } });
      const r = await call("https://api.example.test/v1/me", f);
      expect(r.crossOriginRedirect?.status).toBe(307);
      expect(f.seen.map((s) => s.url)).toEqual(["https://api.example.test/v1/me"]);
      expect(f.seen[0]?.headers["x-api-key"]).toBe(KEY);
    }
  });

  it("follows same-origin redirects with the header", async () => {
    const f = fakeFetch({
      "https://api.example.test/v1/me": { status: 302, location: "/v2/me" },
      "https://api.example.test/v2/me": { status: 200, body: "ok" },
    });
    const r = await call("https://api.example.test/v1/me", f);
    expect(r.response.status).toBe(200);
    expect(f.seen.map((s) => s.headers["x-api-key"])).toEqual([KEY, KEY]);
  });

  it("refuses plain HTTP and other hosts; errors carry no header", async () => {
    const f = fakeFetch({});
    await expect(call("http://api.example.test/v1", f)).rejects.toMatchObject({
      details: { reason: "not_https" },
    });
    await expect(call("https://other.example.test/v1", f)).rejects.toMatchObject({
      code: "policy_denied",
    });
    const err = await authorizedFetch({
      broker: h.vault,
      placeholder: "{{cred:example.header}}",
      approvalId: await approveFill(h, {
        slug: "example",
        target: "https://api.example.test",
        executor: "connector",
        field: "header",
      }),
      url: "https://api.example.test/offline",
      headerName: "X-Api-Key",
      fetchImpl: f.impl,
    }).catch((e: unknown) => e);
    expect(JSON.stringify(err) + String(err)).not.toContain(KEY);
    expect(String((err as Error).message)).toMatch(/ECONNREFUSED/);
  });

  it("rebuilds library errors from an allowlisted shape and masks echoed keys", () => {
    const axiosLike = {
      message: `Request failed: invalid key ${KEY}`,
      code: "ERR_BAD_REQUEST",
      response: { status: 401 },
      config: { headers: { "X-Api-Key": KEY } },
    };
    const safe = safeHttpError(axiosLike, (t) => h.vault.redact(t));
    expect(safe.status).toBe(401);
    expect(JSON.stringify(safe)).not.toContain(KEY);
    expect(JSON.stringify(safe)).not.toContain(KEY.slice(-12));
  });
});

describe("sandbox env injection", () => {
  const target = { kind: "origin" as const, value: "https://api.example.test" };
  it("builds PSYCHE_SECRET_<NAME> for one command and disposes it", async () => {
    const apr = await approveFill(h, {
      slug: "example",
      target: target.value,
      executor: "sandbox",
      field: "token",
    });
    const env = await buildSecretEnv({
      broker: h.vault,
      target,
      entries: [{ name: "EXAMPLE", placeholder: "{{cred:example.token}}", approvalId: apr }],
    });
    expect(env.env).toEqual({ PSYCHE_SECRET_EXAMPLE: KEY });
    expect(Object.keys(env.env)).not.toContain("PATH"); // nothing inherited
    env.dispose();
    expect(env.env).toEqual({});
    expect(h.vault.redact(`echo ${KEY}`)).toBe("echo •••");
  });

  it("rejects bad names and leaves nothing behind on a partial failure", async () => {
    await expect(
      buildSecretEnv({
        broker: h.vault,
        target,
        entries: [{ name: "lower", placeholder: "{{cred:example}}", approvalId: "a" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const apr = await approveFill(h, {
      slug: "example",
      target: target.value,
      executor: "sandbox",
      field: "token",
    });
    await expect(
      buildSecretEnv({
        broker: h.vault,
        target,
        entries: [
          { name: "OK", placeholder: "{{cred:example.token}}", approvalId: apr },
          { name: "BAD", placeholder: "{{cred:example.token}}", approvalId: "apr_missing" },
        ],
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });
});
