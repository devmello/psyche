import { inspect } from "node:util";
import type { BindingVerification, PermissionBroker } from "@psyche/protocol";
import { describeCredentialBrokerConformance } from "@psyche/testing/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialFillBindingHash, parseTotpSeed, totpCode } from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";
import { SSH_KEY_BLOCK } from "./samples.ts";

const GH = { kind: "origin" as const, value: "https://github.com" };
const PW = "gh-password-0123456789";

/** Treat `approvalId` as an approved once credential_fill for exactly `slug` on `origin`. */
function conformanceBroker(
  h: Harness,
  approvalId: string,
  slug: string,
  origin: string,
): PermissionBroker {
  let used = false;
  const verifyBinding = async (id: string, hash: string): Promise<BindingVerification> => {
    if (id !== approvalId) return { ok: false, reason: "not_found" };
    if (used) return { ok: false, reason: "consumed" };
    const meta = (await h.vault.list()).find((m) => m.slug === slug);
    if (meta === undefined) return { ok: false, reason: "not_found" };
    const base = { itemId: meta.id, target: origin };
    const ok = [
      ...(["secret", "username", "password"] as const).map((field) =>
        credentialFillBindingHash({ ...base, field, executor: "connector" }),
      ),
      credentialFillBindingHash({
        ...base,
        field: "secret",
        executor: "browser",
        element: { tagName: "input", type: "password", autocomplete: "current-password" },
      }),
    ];
    if (!ok.includes(hash as `sha256:${string}`)) return { ok: false, reason: "binding_mismatch" };
    used = true;
    const approval = { kind: "credential_fill" } as unknown as Extract<
      BindingVerification,
      { ok: true }
    >["approval"];
    return { ok: true, approval };
  };
  return new Proxy({ verifyBinding } as unknown as PermissionBroker, {
    get: (t, p) =>
      p in t
        ? t[p as keyof PermissionBroker]
        : () => Promise.reject(new Error(`stub: ${String(p)}`)),
  });
}

describeCredentialBrokerConformance("Vault", async (ctx) => {
  let broker: PermissionBroker | undefined;
  const h = makeHarness({
    overrides: {
      clock: ctx.clock,
      permissions: new Proxy({} as PermissionBroker, {
        get: (_t, p) => (broker as unknown as Record<string | symbol, unknown>)[p],
      }),
    },
  });
  broker = conformanceBroker(h, ctx.seed.approvalId, ctx.seed.slug, ctx.seed.origin);
  await h.vault.setup();
  await h.vault.add({
    kind: "login",
    name: "Conformance",
    slug: ctx.seed.slug,
    bindings: [{ origin: ctx.seed.origin }],
    secret: { username: ctx.seed.username, password: ctx.seed.password },
  });
  await h.vault.add({
    kind: "login",
    name: "Other",
    slug: ctx.seed.other.slug,
    bindings: [{ origin: ctx.seed.origin }],
    secret: { password: ctx.seed.other.password },
  });
  return h.vault;
});

let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
  await h.vault.add({
    kind: "login",
    name: "GitHub",
    bindings: [{ origin: "https://github.com" }],
    secret: { username: "pat", password: PW, totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
  });
});
afterEach(() => h.cleanup());

const browserFill = (
  apr: string,
  element = PASSWORD_FIELD,
  selector = "ref_7",
  placeholder = "{{cred:github}}",
) => h.vault.resolve(placeholder, GH, apr, { executor: "browser", element, selector });

describe("resolve (G4, G5, G7)", () => {
  it("fills with a matching approval; the handle is one-shot and prints as [redacted]", async () => {
    const apr = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    const handle = await browserFill(apr);
    expect(
      `${handle} ${JSON.stringify(handle)} ${inspect(handle, { showHidden: true })}`,
    ).not.toContain(PW);
    expect(handle.use((v) => v)).toBe(PW);
    expect(() => handle.use((v) => v)).toThrow(/spent/);
    expect(handle.spent).toBe(true);
    const kinds = (await h.audit.list()).map((e) => e.kind);
    expect(kinds).toContain("credential.filled");
    expect(JSON.stringify(await h.audit.list())).not.toContain(PW);
  });

  it("refuses and logs a fill on a non-matching origin (G5)", async () => {
    const apr = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    for (const value of [
      "https://github.com.evil.example",
      "http://github.com",
      "https://gist.github.com",
    ]) {
      await expect(
        h.vault.resolve("{{cred:github}}", { kind: "origin", value }, apr, {
          executor: "browser",
          element: { ...PASSWORD_FIELD, frameOrigin: value, formActionOrigin: value },
          selector: "ref_7",
        }),
      ).rejects.toMatchObject({ code: "policy_denied", details: { reason: "target_mismatch" } });
    }
    const meta = (await h.vault.list())[0];
    const uses = h.vault.uses(meta?.id ?? "");
    expect(uses.map((u) => [u.outcome, u.reason])).toEqual(
      Array(3).fill(["denied", "target_mismatch"]),
    );
    expect((await h.audit.list()).filter((e) => e.kind === "credential.fill_denied")).toHaveLength(
      3,
    );
    // The denial did not consume the approval.
    (await browserFill(apr)).dispose();
  });

  it("requires an approval, refuses expired, consumed and mismatched ones", async () => {
    await expect(browserFill("")).rejects.toMatchObject({
      code: "approval_required",
      details: { reason: "missing_approval" },
    });
    await expect(browserFill("apr_unknown")).rejects.toMatchObject({
      details: { reason: "approval_not_found" },
    });
    const expired = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    h.clock.advance(31 * 60_000);
    await expect(browserFill(expired)).rejects.toMatchObject({
      code: "approval_required",
      details: { reason: "approval_expired" },
    });
    const once = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    (await browserFill(once)).dispose();
    await expect(browserFill(once)).rejects.toMatchObject({
      details: { reason: "approval_consumed" },
    });
    const other = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_9",
      element: PASSWORD_FIELD,
    });
    await expect(browserFill(other)).rejects.toMatchObject({
      details: { reason: "approval_binding_mismatch" },
    });
  });

  it("marks the approval request as authenticated, device-only, once + opt-in site (G7)", async () => {
    const meta = (await h.vault.list())[0];
    if (meta === undefined) throw new Error("no item");
    const issued = await h.vault.requestFill({
      slug: "github",
      target: GH.value,
      executor: "browser",
      selector: "ref_7",
      element: PASSWORD_FIELD,
      requestedBy: { runId: null, taskId: "task_1", threadId: null, agent: "Pip" },
      taint: false,
      surfaces: ["desktop", "notification", "telegram:42"],
    });
    expect(issued.approval).toMatchObject({
      kind: "credential_fill",
      requiresAuthentication: true,
      deviceOnly: true,
      surfaces: ["desktop", "notification"],
      details: {
        item: "GitHub",
        site: "https://github.com",
        task: "task_1",
        agent: "Pip",
        field: "password",
      },
    });
    expect(issued.approval.scopesOffered).toEqual(expect.arrayContaining(["once", "site"]));
    expect(issued.approval.grantKey).toBe(
      `credential_fill|${meta.id}|https://github.com|password|browser`,
    );
  });

  it("prompts Touch ID on the first fill while locked, naming item and site", async () => {
    const apr = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    h.vault.lock();
    (await browserFill(apr)).dispose();
    expect(h.helper.prompts).toEqual(["Fill “GitHub” on https://github.com"]);
  });

  it("stays locked when unlockOnFill is off", async () => {
    const strict = h.reopen({ unlockOnFill: false });
    h.vault.lock();
    const apr = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    await expect(
      strict.resolve("{{cred:github}}", GH, apr, {
        executor: "browser",
        element: PASSWORD_FIELD,
        selector: "ref_7",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("resolves .totp to the current code, never the seed (RFC 6238)", async () => {
    const seed = parseTotpSeed("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    // RFC 6238 appendix B, SHA-1 seed "12345678901234567890": T=59 s → 94287082, T=1111111109 → 07081804.
    expect(totpCode({ ...seed, digits: 8 }, 59_000)).toBe("94287082");
    expect(totpCode({ ...seed, digits: 8 }, 1_111_111_109_000)).toBe("07081804");
    const otpField = { tagName: "input", autocomplete: "one-time-code", frameOrigin: GH.value };
    const apr = await approveFill(h, {
      slug: "github",
      target: GH.value,
      field: "totp",
      selector: "ref_8",
      element: otpField,
    });
    const handle = await browserFill(apr, otpField, "ref_8", "{{cred:github.totp}}");
    const code = handle.use((v) => v);
    expect(code).toBe(totpCode(seed, h.clock.now()));
    expect(code).toMatch(/^\d{6}$/);
  });

  it("asks for presence on every use of requireAuthEachUse items", async () => {
    await h.vault.add({
      kind: "ssh_key",
      name: "Deploy key",
      bindings: [{ host: "git.example.com" }],
      secret: { privateKey: SSH_KEY_BLOCK },
    });
    const target = { kind: "origin" as const, value: "https://git.example.com" };
    for (let i = 0; i < 2; i += 1) {
      const apr = await approveFill(h, {
        slug: "deploy-key",
        target: target.value,
        executor: "ssh",
      });
      (await h.vault.resolve("{{cred:deploy-key}}", target, apr, { executor: "ssh" })).dispose();
    }
    expect(h.helper.prompts).toEqual(["Use “Deploy key”", "Use “Deploy key”"]);
  });

  it("formats .header as prefix + token for host-bound API keys", async () => {
    await h.vault.add({
      kind: "api_key",
      name: "Example API",
      bindings: [{ host: "api.example.com" }],
      secret: {
        token: "ex-api-key-abcdef123456",
        headerName: "Authorization",
        headerPrefix: "Bearer ",
      },
    });
    const target = { kind: "origin" as const, value: "https://api.example.com" };
    const apr = await approveFill(h, {
      slug: "example-api",
      target: target.value,
      executor: "connector",
      field: "header",
    });
    const handle = await h.vault.resolve("{{cred:example-api.header}}", target, apr, {
      executor: "connector",
    });
    expect(handle.use((v) => v)).toBe("Bearer ex-api-key-abcdef123456");
    expect(await h.vault.headerName("example-api")).toBe("Authorization");
    // Host bindings are https only.
    const apr2 = await approveFill(h, {
      slug: "example-api",
      target: target.value,
      executor: "connector",
      field: "header",
    });
    await expect(
      h.vault.resolve(
        "{{cred:example-api.header}}",
        { kind: "origin", value: "http://api.example.com" },
        apr2,
        { executor: "connector" },
      ),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("concurrent fills while locked share one Touch ID prompt", async () => {
    const a = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    const b = await approveFill(h, {
      slug: "github",
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    h.vault.lock();
    const [x, y] = await Promise.all([browserFill(a), browserFill(b)]);
    x.dispose();
    y.dispose();
    expect(h.helper.prompts).toHaveLength(1);
  });
});
