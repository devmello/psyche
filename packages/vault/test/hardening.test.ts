/** M3 hardening review findings owned by S06: #292 (http origins) and the vault side of #290. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindingMatches,
  bindingProblem,
  buildSecretEnv,
  type CdpSession,
  fillBrowserField,
  importRows,
  isFillableOrigin,
} from "../src/index.ts";
import { approveFill, type Harness, makeHarness } from "./helpers.ts";

describe("#292: credentials fill over https, or http on a loopback dev server", () => {
  it("refuses plain-http bindings except literal loopback hosts", () => {
    for (const origin of [
      "http://example.com",
      "http://app.test",
      "http://192.168.1.10:8080",
      "http://localhost.example.com",
    ]) {
      expect(bindingProblem({ origin }), origin).toMatch(/https/);
    }
    for (const origin of [
      "https://example.com",
      "http://localhost:3000",
      "http://app.localhost",
      "http://127.0.0.1:8080",
      "http://[::1]:5173",
    ]) {
      expect(bindingProblem({ origin }), origin).toBeNull();
    }
    expect(isFillableOrigin("http://example.com")).toBe(false);
  });

  it("an http binding stored before the rule never matches, not even its own origin", () => {
    expect(
      bindingMatches([{ origin: "http://example.com" }], {
        kind: "origin",
        value: "http://example.com",
      }),
    ).toBe(false);
    expect(
      bindingMatches([{ origin: "http://localhost:3000" }], {
        kind: "origin",
        value: "http://localhost:3000",
      }),
    ).toBe(true);
  });

  it("imports skip plain-http URIs with a warning", () => {
    const r = importRows(
      "name,url,username,password\nold site,http://legacy.example.com/login,u,legacy-pw-0001\n",
      "chrome",
    );
    expect(r.rows[0]).toMatchObject({
      ok: true,
      bindings: [],
      warnings: expect.arrayContaining([expect.stringMatching(/plain-http/)]),
    });
  });

  describe("at fill time", () => {
    let h: Harness;
    beforeEach(async () => {
      h = makeHarness();
      await h.vault.setup();
    });
    afterEach(() => h.cleanup());

    it("adding an item bound to http://example.com is refused", async () => {
      await expect(
        h.vault.add({
          kind: "login",
          name: "Legacy",
          bindings: [{ origin: "http://example.com" }],
          secret: { password: "legacy-pw-0002" },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    });

    it("the browser fill refuses an http page before asking the broker", async () => {
      await h.vault.add({
        kind: "login",
        name: "Dev",
        bindings: [{ origin: "http://localhost:3000" }],
        secret: { password: "dev-pw-0003" },
      });
      const sent: string[] = [];
      const cdp: CdpSession = {
        async send(method) {
          sent.push(method);
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: {
                  id: "F",
                  url: "http://example.com/login",
                  securityOrigin: "http://example.com",
                },
              },
            };
          }
          return {};
        },
      };
      const apr = await approveFill(h, {
        slug: "dev",
        target: "http://localhost:3000",
        executor: "connector",
      });
      const r = await fillBrowserField({
        cdp,
        broker: h.vault,
        placeholder: "{{cred:dev}}",
        approvalId: apr,
        selector: "ref_1",
      });
      expect(r).toMatchObject({ ok: false, reason: "insecure_origin" });
      expect(sent).toEqual(["Page.getFrameTree"]);
    });
  });
});

describe("#290 (vault side): a sandbox secret lives for one command", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await h.vault.setup();
    await h.vault.add({
      kind: "api_key",
      name: "Deploy",
      bindings: [{ host: "api.example.com" }],
      secret: { token: "deploy-token-0123456789" },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    h.cleanup();
  });
  const target = { kind: "origin" as const, value: "https://api.example.com" };
  const lease = async (timeoutMs: number, now?: () => number) =>
    buildSecretEnv({
      broker: h.vault,
      target,
      entries: [
        {
          name: "DEPLOY",
          placeholder: "{{cred:deploy.token}}",
          approvalId: await approveFill(h, {
            slug: "deploy",
            target: target.value,
            executor: "sandbox",
            field: "token",
          }),
        },
      ],
      lease: { timeoutMs, graceMs: 0, ...(now === undefined ? {} : { now }) },
    });

  it("wipes the env when the command's timeout has passed, even without dispose()", async () => {
    vi.useFakeTimers();
    const env = await lease(2_000);
    expect(env.env).toEqual({ PSYCHE_SECRET_DEPLOY: "deploy-token-0123456789" });
    expect(env.active).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(env.env).toEqual({});
    expect(env.active).toBe(false);
  });

  it("reports expiry from the clock even before the timer fires", async () => {
    let t = 1_000_000;
    const env = await lease(500, () => t);
    expect(env.expiresAt).toBe(1_000_500);
    t = 1_000_500;
    expect(env.active).toBe(false);
    expect(env.env).toEqual({});
  });

  it("dispose is idempotent and the approval is not reusable for another command", async () => {
    const apr = await approveFill(h, {
      slug: "deploy",
      target: target.value,
      executor: "sandbox",
      field: "token",
    });
    const entries = [{ name: "DEPLOY", placeholder: "{{cred:deploy.token}}", approvalId: apr }];
    const env = await buildSecretEnv({
      broker: h.vault,
      target,
      entries,
      lease: { timeoutMs: 60_000 },
    });
    env.dispose();
    env.dispose();
    expect(env.active).toBe(false);
    await expect(
      buildSecretEnv({ broker: h.vault, target, entries, lease: { timeoutMs: 60_000 } }),
    ).rejects.toMatchObject({
      code: "approval_required",
    });
  });

  it("refuses a lease without a positive timeout", async () => {
    await expect(lease(0 - 1)).rejects.toMatchObject({ code: "invalid_params" });
  });
});
