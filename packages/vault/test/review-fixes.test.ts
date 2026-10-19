/** Regressions for the S06 adversarial review (findings beyond the S23 set). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindingProblem, importRows, SecretRedactor } from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";
import { VISA } from "./samples.ts";

const GH = { kind: "origin" as const, value: "https://github.com" };
let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
  await h.vault.add({
    kind: "login",
    name: "GitHub",
    bindings: [{ origin: GH.value }],
    secret: { password: "review-fix-password-1" },
  });
});
afterEach(() => h.cleanup());

const fill = (apr: string) =>
  h.vault.resolve("{{cred:github}}", GH, apr, {
    executor: "browser",
    element: PASSWORD_FIELD,
    selector: "ref_7",
  });
const approve = () =>
  approveFill(h, { slug: "github", target: GH.value, selector: "ref_7", element: PASSWORD_FIELD });

describe("review fixes", () => {
  it("the encrypted store, not the plaintext mirror, decides owner and bindings", async () => {
    const token = await h.vault.store({
      connectorId: "con_g",
      slug: "g-token",
      name: "G",
      bindings: [{ connector: "con_g" }],
      tokens: { accessToken: "oauth-access-token-xyz" },
    });
    // Tamper with the mirror row in the main database.
    h.meta.upsert({
      ...token,
      ownerConnectorId: null,
      bindings: [{ origin: "https://evil.example" }],
    });
    const apr = await approveFill(h, {
      slug: "g-token",
      target: "https://evil.example",
      executor: "connector",
    });
    await expect(
      h.vault.resolve("{{cred:g-token}}", { kind: "origin", value: "https://evil.example" }, apr),
    ).rejects.toMatchObject({ code: "policy_denied", details: { reason: "connector_owned" } });
    const gh = (await h.vault.list()).find((m) => m.slug === "github");
    if (gh === undefined) throw new Error("no item");
    h.meta.upsert({ ...gh, bindings: [{ origin: "https://evil.example" }] });
    const apr2 = await approveFill(h, {
      slug: "github",
      target: "https://evil.example",
      executor: "connector",
    });
    await expect(
      h.vault.resolve("{{cred:github}}", { kind: "origin", value: "https://evil.example" }, apr2),
    ).rejects.toMatchObject({ details: { reason: "target_mismatch" } });
  });

  it("refuses wildcards over shared or public suffixes and in imports", async () => {
    for (const origin of [
      "https://*.github.io",
      "https://*.com",
      "https://*.co.uk",
      "https://*.vercel.app",
      "https://a*.example.com",
    ]) {
      expect(bindingProblem({ origin }), origin).not.toBeNull();
    }
    expect(bindingProblem({ origin: "https://*.example.com" })).toBeNull();
    const r = importRows("name,url,username,password\nx,*.com,u,import-pw-0001\n", "chrome");
    expect(r.rows[0]).toMatchObject({ ok: true, bindings: [] });
  });

  it("masks form-encoded and lowercase percent-encoded values", () => {
    const r = new SecretRedactor();
    const v = "Tr0ub4dor!(x)~yz";
    r.add(v);
    const q = new URLSearchParams({ pw: v }).toString();
    expect(r.contains(q)).toBe(true);
    expect(r.redact(`/login?${q}`)).toBe("/login?pw=•••");
    expect(r.redact(encodeURIComponent("a b/c+d=secret").toLowerCase())).toBe(
      encodeURIComponent("a b/c+d=secret").toLowerCase(),
    );
    const w = "pass word/with+chars";
    r.add(w);
    expect(r.contains(encodeURIComponent(w).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()))).toBe(
      true,
    );
  });

  it("import skip reasons never repeat cell contents", () => {
    const csv = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,credit card ${VISA},x,,,0,,,,\n`;
    const r = importRows(csv, "bitwarden");
    expect(r.rows[0]).toEqual({ ok: false, row: 2, reason: "refused: card items" });
  });

  it("a locked vault or a cancelled Touch ID does not consume the approval", async () => {
    const strict = h.reopen({ unlockOnFill: false });
    const apr = await approve();
    h.vault.lock();
    await expect(
      strict.resolve("{{cred:github}}", GH, apr, {
        executor: "browser",
        element: PASSWORD_FIELD,
        selector: "ref_7",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    h.helper.state.touchId = "cancel";
    await expect(fill(apr)).rejects.toMatchObject({ code: "cancelled" });
    h.helper.state.touchId = "approve";
    (await fill(apr)).dispose();
    const meta = (await h.vault.list()).find((m) => m.slug === "github");
    expect(h.vault.uses(meta?.id ?? "").map((u) => `${u.outcome}:${u.reason}`)).toEqual([
      "filled:null",
      "failed:unlock_refused",
      "failed:locked",
    ]);
  });

  it("a missing field fails before the approval is consumed", async () => {
    const apr = await approveFill(h, {
      slug: "github",
      target: GH.value,
      executor: "connector",
      field: "totp",
    });
    await expect(h.vault.resolve("{{cred:github.totp}}", GH, apr)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("unlock and recovery unlock run one at a time and leave one open store", async () => {
    const fresh = makeHarness();
    const { recoveryKey: key } = await fresh.vault.setup();
    fresh.vault.lock();
    await Promise.all([
      fresh.vault.unlock("a"),
      fresh.vault.unlockWithRecovery(key),
      fresh.vault.unlock("b"),
    ]);
    expect(fresh.vault.locked).toBe(false);
    expect(fresh.vault.lock().state).toBe("locked");
    fresh.cleanup();
  });

  it("a form whose submit buttons post elsewhere is refused (formaction)", async () => {
    const apr = await approve();
    await expect(
      h.vault.resolve("{{cred:github}}", GH, apr, {
        executor: "browser",
        element: { ...PASSWORD_FIELD, formActionOrigin: "null" },
        selector: "ref_7",
      }),
    ).rejects.toMatchObject({ details: { reason: "form_action_mismatch" } });
  });
});
