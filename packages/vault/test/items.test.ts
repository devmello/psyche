import {
  assertNoSecrets,
  clearSecrets,
  loadSecretRegistry,
  registerSecret,
  resolveSample,
  type Sample,
} from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { luhnValid, REFUSAL_EXPLANATION, scanText } from "../src/index.ts";
import { approveFill, type Harness, makeHarness } from "./helpers.ts";
import { AMEX, IBAN_GB_SPACED, MC_DASHED, SSN, VISA, VISA_SPACED } from "./samples.ts";

let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
});
afterEach(() => {
  h.cleanup();
  clearSecrets();
});

const login = (password: string, extra: { text?: string; name?: string } = {}) =>
  h.vault.add({
    kind: "login",
    name: extra.name ?? "Site",
    bindings: [{ origin: "https://site.example" }],
    secret: {
      username: "pat",
      password,
      ...(extra.text === undefined ? {} : { text: extra.text }),
    },
  });

describe("items (G2, G3)", () => {
  it("lists metadata only, never values", async () => {
    const pw = "list-metadata-secret-77";
    registerSecret(pw, "pw");
    const meta = await login(pw);
    expect(meta).toMatchObject({
      kind: "login",
      slug: "site",
      useCount: 0,
      ownerConnectorId: null,
    });
    assertNoSecrets(await h.vault.list(), "vault.list");
    assertNoSecrets(await h.vault.get(meta.id), "vault.get");
    assertNoSecrets(await h.audit.list(), "audit");
  });

  it("binds one login to several origins and normalizes them", async () => {
    const meta = await h.vault.add({
      kind: "login",
      name: "Google",
      bindings: [{ origin: "https://Accounts.Google.com/" }, { origin: "https://*.google.com" }],
      secret: { password: "multi-origin-pw-1234" },
    });
    expect(meta.bindings).toEqual([
      { origin: "https://accounts.google.com" },
      { origin: "https://*.google.com" },
    ]);
    for (const bad of [
      "https://x.com/login",
      "android://com.bank",
      "javascript:alert(1)",
      "https://u:p@x.com",
    ]) {
      await expect(
        h.vault.add({
          kind: "login",
          name: "b",
          bindings: [{ origin: bad }],
          secret: { password: "x-123456" },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
  });

  it("derives unique slugs and validates given ones", async () => {
    expect((await login("a-123456", { name: "My Bank!" })).slug).toBe("my-bank");
    expect((await login("b-123456", { name: "My Bank!" })).slug).toBe("my-bank-2");
    await expect(
      h.vault.add({
        kind: "note",
        name: "n",
        slug: "Bad Slug",
        bindings: [],
        secret: { text: "t" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("refuses card numbers, CVVs, bank accounts and government ids with an explanation", async () => {
    const refused: [string, { password?: string; text?: string }][] = [
      ["card", { password: VISA_SPACED }],
      ["card in notes", { password: "fine-password-1", text: `visa ${MC_DASHED} exp 12/29` }],
      ["amex", { password: AMEX }],
      ["cvv", { password: "fine-password-2", text: "CVV: 123" }],
      ["iban", { password: "fine-password-3", text: IBAN_GB_SPACED }],
      ["ssn", { password: "fine-password-4", text: `ssn ${SSN}` }],
      ["passport", { password: "fine-password-5", text: "passport number X1234567" }],
      ["routing", { password: "fine-password-6", text: "routing number 021000021" }],
    ];
    for (const [label, s] of refused) {
      const err = await login(s.password ?? "x", s.text === undefined ? {} : { text: s.text }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, label).toMatchObject({ code: "policy_denied", message: REFUSAL_EXPLANATION });
      expect(JSON.stringify(err), label).not.toContain(s.text ?? s.password ?? "");
      expect(REFUSAL_EXPLANATION).toMatch(/Stripe Link/);
    }
    expect((await h.vault.list()).length).toBe(0);
  });

  it("does not refuse ordinary secrets that happen to be numeric", async () => {
    await login("1234567812345678"); // fails Luhn
    await login("4111111111111112"); // Visa prefix, fails Luhn
    await login("9999999999999995"); // passes Luhn, no issuer
    expect(luhnValid(VISA)).toBe(true);
    expect(scanText("call me at 415-555-0100")).toBeNull();
  });

  it("refuses payment_link from the UI; signing keys are not supported yet", async () => {
    await expect(
      h.vault.add({
        kind: "payment_link",
        name: "p",
        bindings: [],
        secret: { token: "tok-123456" },
      }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringMatching(/Stripe Link/),
    });
    await expect(
      h.vault.add({ kind: "signing_key", name: "s", bindings: [], secret: { privateKey: "k" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("edits and deletes; deleted items vanish from the mirror", async () => {
    const meta = await login("edit-me-secret-1");
    const events: string[] = [];
    h.vault.on("credential.updated", (e) => events.push(e.change));
    const edited = await h.vault.update(meta.id, {
      name: "Renamed",
      secret: { password: "edited-secret-2" },
    });
    expect(edited.name).toBe("Renamed");
    await expect(h.vault.update(meta.id, { secret: { text: VISA_SPACED } })).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(await h.vault.delete(meta.id)).toBe(true);
    expect(await h.vault.get(meta.id)).toBeUndefined();
    expect(await h.vault.delete(meta.id)).toBe(false);
    expect(events).toEqual(["updated", "deleted"]);
    const kinds = (await h.audit.list()).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["credential.created", "credential.updated", "credential.deleted"]),
    );
  });

  it("keeps the last 50 uses per item, newest first (G14)", async () => {
    await login("uses-secret-123456");
    const meta = (await h.vault.list())[0];
    if (meta === undefined) throw new Error("no item");
    for (let i = 0; i < 55; i += 1) {
      const apr = await approveFill(h, {
        slug: "site",
        target: "https://site.example",
        executor: "connector",
      });
      (
        await h.vault.resolve(
          "{{cred:site}}",
          { kind: "origin", value: "https://site.example" },
          apr,
          { taskId: `task_${i}` },
        )
      ).dispose();
      h.clock.advance(1000);
    }
    const uses = h.vault.uses(meta.id);
    expect(uses).toHaveLength(50);
    expect(uses[0]).toMatchObject({
      outcome: "filled",
      taskId: "task_54",
      executor: "connector",
      target: "https://site.example",
    });
    expect((await h.vault.get(meta.id))?.useCount).toBe(55);
  });
});

describe("refusal scanner vs the shared pattern registry (S18)", () => {
  const { patternSamples } = loadSecretRegistry();
  const kinds: [string, string][] = [
    ["card", "card_number"],
    ["us_ssn", "government_id"],
    ["iban", "bank_account"],
    ["us_bank_account", "bank_account"],
    ["passport", "government_id"],
  ];
  it.each(kinds)("refuses every %s sample and ignores the look-alikes", (kind, category) => {
    const set = patternSamples[kind] as
      | { mustMatch?: Sample[]; mustNotMatch?: Sample[] }
      | undefined;
    for (const s of set?.mustMatch ?? [])
      expect(scanText(resolveSample(s)), resolveSample(s)).toBe(category);
    for (const s of set?.mustNotMatch ?? [])
      expect(scanText(resolveSample(s)), resolveSample(s)).toBeNull();
  });
});
