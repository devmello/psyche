import { clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fail } from "../src/errors.ts";
import {
  type BitwardenSource,
  buildSecretEnv,
  type ManagedBy,
  type OnePasswordSource,
} from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

/** #511: the owner can delete every item they created; Gateway-owned items say where they go. */

const PW = "delete-me-password-63";
const KEY = "delete-me-api-key-0123456789";
const API = { kind: "origin" as const, value: "https://api.example.test" };
const GH = { kind: "origin" as const, value: "https://github.com" };

const onePassword: OnePasswordSource = {
  kind: "cli",
  unavailableReason: async () => null,
  readField: async () => fail("not_found", "unused"),
};
const bitwarden: BitwardenSource = {
  kind: "cli",
  unavailableReason: async () => null,
  readField: async () => fail("not_found", "unused"),
};

/** The Gateway's owner ids (apps/gateway compose/vault.ts `gatewayOwner`). */
const owners = (id: string): ManagedBy | undefined =>
  id.startsWith("model-")
    ? { kind: "model_provider", setting: "models", removable: false }
    : id === "bitwarden"
      ? { kind: "external_manager", setting: "credentials", removable: true }
      : undefined;

let h: Harness;
beforeEach(async () => {
  h = makeHarness({ overrides: { onePassword, bitwarden, owners } });
  await h.vault.setup();
  registerSecret(PW, "pw");
  registerSecret(KEY, "key");
});
afterEach(() => {
  h.cleanup();
  clearSecrets();
});

const deletedAudit = async () =>
  (await h.audit.list()).filter((e) => e.kind === "credential.deleted").map((e) => e.data);

describe("vault.delete (#511)", () => {
  it("deletes every kind the owner can create, external links included, and audits it", async () => {
    const made = [
      await h.vault.add({
        kind: "login",
        name: "GitHub",
        bindings: [{ origin: GH.value }],
        secret: { username: "pat", password: PW },
      }),
      await h.vault.add({ kind: "api_key", name: "API", bindings: [], secret: { token: KEY } }),
      await h.vault.add({ kind: "note", name: "Wifi", bindings: [], secret: { text: "x-note-1" } }),
      await h.vault.add({
        kind: "ssh_key",
        name: "Box",
        bindings: [{ host: "box.example.test" }],
        secret: { privateKey: "fake-ssh-private-key-body" },
      }),
      await h.vault.linkOnePassword({
        kind: "login",
        name: "Shop (1Password)",
        bindings: [],
        ref: { vault: "Private", item: "Shop" },
      }),
      await h.vault.linkBitwarden({
        kind: "login",
        name: "Shop (Bitwarden)",
        bindings: [],
        ref: { item: "Shop" },
      }),
    ];
    for (const c of made) await expect(h.vault.delete(c.id)).resolves.toBe(true);
    expect(await h.vault.list()).toEqual([]);
    expect(await h.vault.delete(made[0]?.id ?? "")).toBe(false);
    expect(await deletedAudit()).toEqual(
      made.map((c) =>
        expect.objectContaining({
          credentialId: c.id,
          slug: c.slug,
          kind: c.kind,
          backend: c.backend,
          grantsRevoked: 0,
        }),
      ),
    );
  });

  it("revokes the item's site grants, so a later fill cannot ride on them", async () => {
    const c = await h.vault.add({
      kind: "login",
      name: "GitHub",
      bindings: [{ origin: GH.value }],
      secret: { username: "pat", password: PW },
    });
    await approveFill(h, {
      slug: c.slug,
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
      scope: "site",
    });
    const live = async () =>
      (await h.permissions.listGrants({ kind: "credential_fill" })).filter(
        (g) => g.revokedAt === null,
      );
    expect(await live()).toHaveLength(1);
    await h.vault.delete(c.id);
    expect(await live()).toEqual([]);
    expect(await deletedAudit()).toEqual([expect.objectContaining({ grantsRevoked: 1 })]);
  });

  it("wipes a live secret env lease and an unused fill handle drawn from the item", async () => {
    const c = await h.vault.add({
      kind: "api_key",
      name: "Example",
      bindings: [{ host: "api.example.test" }],
      secret: { token: KEY },
    });
    const forEnv = await approveFill(h, {
      slug: c.slug,
      target: API.value,
      executor: "sandbox",
      field: "token",
    });
    const env = await buildSecretEnv({
      broker: h.vault,
      target: API,
      entries: [{ name: "EXAMPLE", placeholder: `{{cred:${c.slug}.token}}`, approvalId: forEnv }],
    });
    expect(env.active).toBe(true);
    const forHandle = await approveFill(h, {
      slug: c.slug,
      target: API.value,
      executor: "connector",
    });
    const handle = await h.vault.resolve(`{{cred:${c.slug}}}`, API, forHandle);
    expect(handle.spent).toBe(false);

    await h.vault.delete(c.id);
    expect(env.active).toBe(false);
    expect(env.env).toEqual({});
    expect(handle.spent).toBe(true);
    expect(() => handle.use((v) => v)).toThrow(/spent/);
    expect(await deletedAudit()).toEqual([
      expect.objectContaining({ leasesEnded: 1, handlesDisposed: 1 }),
    ]);
    // Values the item handed out stay masked after it is gone.
    expect(h.vault.redact(`echo ${KEY}`)).toBe("echo •••");
  });

  it("refuses Gateway-owned items with the setting that removes them", async () => {
    const key = await h.vault.store({
      connectorId: "model-anthropic",
      slug: "model-anthropic",
      name: "Anthropic API key (models)",
      bindings: [{ connector: "model-anthropic" }],
      tokens: { accessToken: KEY },
    });
    const oauth = await h.vault.store({
      connectorId: "conn_gmail",
      slug: "conn-gmail",
      name: "Gmail",
      bindings: [{ connector: "conn_gmail" }],
      tokens: { accessToken: "oauth-access-token-xyz" },
    });
    await expect(h.vault.delete(key.id)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Settings → Models"),
      details: { reason: "gateway_owned", kind: "model_provider", setting: "models" },
    });
    await expect(h.vault.delete(oauth.id)).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "gateway_owned", kind: "connector", setting: "connectors" },
    });
    const listed = await h.vault.list();
    expect(listed.find((c) => c.id === key.id)?.managedBy).toEqual({
      kind: "model_provider",
      setting: "models",
      removable: false,
    });
    expect(listed.find((c) => c.id === oauth.id)?.managedBy).toMatchObject({ kind: "connector" });
    expect(await deletedAudit()).toEqual([]);
  });

  it("deletes a Gateway-owned item its owner marks removable (the Bitwarden session)", async () => {
    const session = await h.vault.store({
      connectorId: "bitwarden",
      slug: "bitwarden-session",
      name: "Bitwarden session",
      bindings: [{ connector: "bitwarden" }],
      tokens: { accessToken: "bw-session-key-abcdef0123" },
    });
    expect((await h.vault.get(session.id))?.managedBy?.removable).toBe(true);
    await expect(h.vault.delete(session.id)).resolves.toBe(true);
    expect(h.vault.connectorItem("bitwarden")).toBeUndefined();
  });
});
