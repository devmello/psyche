import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeychainItemStore } from "../src/index.ts";
import { approveFill, fakeHelper, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

const PW = "keychain-mode-password-42";
const GH = { kind: "origin" as const, value: "https://github.com" };
let h: Harness;
let id: string;
beforeEach(async () => {
  h = makeHarness({ keychainMode: true });
  await h.vault.setup();
  registerSecret(PW, "pw");
  id = (
    await h.vault.add({
      kind: "login",
      name: "GitHub",
      bindings: [{ origin: GH.value }],
      secret: { username: "pat", password: PW },
    })
  ).id;
  h.helper.prompts.length = 0;
});
afterEach(() => {
  h.cleanup();
  clearSecrets();
});

const fill = async (field?: "password" | "totp") => {
  const element =
    field === "totp"
      ? { tagName: "input", autocomplete: "one-time-code", frameOrigin: GH.value }
      : PASSWORD_FIELD;
  const apr = await approveFill(h, {
    slug: "github",
    target: GH.value,
    selector: "ref_7",
    element,
    ...(field === undefined ? {} : { field }),
  });
  const placeholder = field === undefined ? "{{cred:github}}" : `{{cred:github.${field}}}`;
  return {
    apr,
    run: () =>
      h.vault.resolve(placeholder, GH, apr, { executor: "browser", element, selector: "ref_7" }),
  };
};

describe("system keychain mode (G9)", () => {
  it("stores the secret as a Psyche keychain item, not in the vault database", async () => {
    expect(h.vault.backendOf(id)).toBe("keychain");
    const entry = h.helper.kcItems.get(`psyche.item.${id.toLowerCase()}`);
    expect(entry?.requireAuth).toBe(true);
    expect(JSON.parse(Buffer.from(entry?.value ?? "", "base64url").toString())).toEqual({
      username: "pat",
      password: PW,
    });
    assertNoSecrets(await h.vault.list(), "metadata");
    // The vault row holds no value: reopen the store and read it directly.
    h.vault.lock();
    const again = h.reopen();
    await again.unlock("check");
    assertNoSecrets(JSON.stringify(await again.list()), "mirror");
    again.lock();
  });

  it("fills through keychain.retrieve, which prompts with item and site", async () => {
    const { run } = await fill();
    const handle = await run();
    expect(handle.use((v) => v)).toBe(PW);
    expect(h.helper.prompts).toEqual(["Fill “GitHub” on https://github.com"]);
    expect(h.vault.redact(`echo ${PW}`)).toBe("echo •••");
  });

  it("a cancelled keychain prompt fails without consuming the approval", async () => {
    const { run } = await fill();
    h.helper.state.touchId = "cancel";
    await expect(run()).rejects.toMatchObject({ code: "cancelled" });
    h.helper.state.touchId = "approve";
    (await run()).dispose();
    expect(h.vault.uses(id).map((u) => `${u.outcome}:${u.reason}`)).toEqual([
      "filled:null",
      "failed:keychain_refused",
    ]);
  });

  it("checks for the field without prompting", async () => {
    const { run } = await fill("totp");
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
    expect(h.helper.prompts).toEqual([]);
  });

  it("edits replace the keychain item; deletes remove it", async () => {
    await h.vault.update(id, { secret: { password: "edited-keychain-pw-77" } });
    expect(h.helper.prompts).toEqual(["Edit “GitHub”"]);
    const { run } = await fill();
    expect((await run()).use((v) => v)).toBe("edited-keychain-pw-77");
    await h.vault.delete(id);
    expect(h.helper.kcItems.size).toBe(0);
  });

  it("moves items between the vault and the keychain", async () => {
    await h.vault.setBackend(id, "vault");
    expect(h.vault.backendOf(id)).toBe("vault");
    expect(h.helper.kcItems.size).toBe(0);
    h.helper.prompts.length = 0;
    const { run } = await fill();
    (await run()).dispose();
    expect(h.helper.prompts).toEqual([]); // vault items need no per-fill prompt
    await h.vault.setBackend(id, "keychain");
    expect(h.vault.backendOf(id)).toBe("keychain");
    expect(h.helper.kcItems.size).toBe(1);
  });

  it("imports into the keychain; connector tokens stay in the vault", async () => {
    const r = await h.vault.importCsv(
      "name,url,username,password\nx,https://x.example,u,imported-kc-pw-01\n",
    );
    expect(h.vault.backendOf(r.imported[0]?.id ?? "")).toBe("keychain");
    const token = await h.vault.store({
      connectorId: "con_g",
      slug: "g",
      name: "G",
      bindings: [{ connector: "con_g" }],
      tokens: { accessToken: "oauth-token-in-vault-1" },
    });
    expect(h.vault.backendOf(token.id)).toBe("vault");
    await expect(h.vault.setBackend(token.id, "keychain")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses keychain mode when the helper lacks the item capabilities", async () => {
    const bare = fakeHelper(); // S14's registered set only
    const store = new KeychainItemStore({ helper: bare.node });
    expect(await store.unavailableReason()).toMatch(/keychain\.store/);
    await expect(store.put("x", Buffer.from("{}"))).rejects.toMatchObject({ code: "unavailable" });
    const noEntitlement = fakeHelper({ items: true });
    noEntitlement.state.dataProtection = "missing_entitlement";
    expect(await new KeychainItemStore({ helper: noEntitlement.node }).unavailableReason()).toMatch(
      /missing_entitlement/,
    );
  });
});
