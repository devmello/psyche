import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceChallenge } from "@psyche/permissions";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeConnectors, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * M7 / N9: the mail connectors are composed, and their vault credential is read under one
 * owner approval per mailbox ("for this account"), which the email channel reuses for its polls.
 * The connector record is a fake; no mail server is contacted.
 */

const PASSWORD = "app-pass-Psyche-MAIL-7781";
let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("mail connectors in the Gateway (M7, N9)", () => {
  it("offers IMAP and JMAP, and reads the mailbox credential under one site approval", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-mail-"));
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 5), { mode: 0o600 });
    let connectors: ReturnType<typeof composeConnectors> | undefined;
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      presence: { verify: async (a, challenge) => a.signature === `ok:${challenge}` },
      parts: [
        (s) => {
          connectors = composeConnectors(s, { syncIntervalMs: 0 });
          return connectors;
        },
      ],
    });
    const c = composed;
    const part = connectors as NonNullable<typeof connectors>;
    expect(part.registry.catalogue().map((e) => e.type)).toEqual(
      expect.arrayContaining(["imap", "jmap"]),
    );

    await c.vault.setup();
    const item = await c.vault.add({
      kind: "api_key",
      name: "Mailbox",
      bindings: [{ connector: "imap-1" }],
      secret: { token: PASSWORD },
    });
    // A connected IMAP connector's record, as the registry stores it.
    const store = new Map([
      [
        "imap-1",
        {
          id: "imap-1",
          type: "imap",
          config: { host: "imap.example.test", password: `{{cred:${item.slug}}}` },
        },
      ],
    ]);
    part.registry.get = (async (id: string) => store.get(id)) as never;

    const owner = await adminClient(c.gateway);
    clients.push(owner);
    const devices = await owner.call<{ devices: { id: string; scopes: string[] }[] }>(
      "devices.list",
      {},
    );
    const ownerId = devices.devices.find((d) => d.scopes.includes("operator.admin"))?.id as string;

    const secret = part.mail.secret("imap-1");
    // A background read never waits: it leaves one card and fails until the owner answers.
    await expect(secret.use(async (v) => v)).rejects.toMatchObject({ code: "approval_required" });
    await expect(secret.use(async (v) => v)).rejects.toMatchObject({ code: "approval_required" });
    const card = await owner.waitForEvent((e) => e.event === "approval.created");
    const p = card.payload as {
      approval: { id: string; kind: string; bindingHash: string; scopesOffered: string[] };
      answerToken: string;
    };
    expect(p.approval.kind).toBe("credential_fill");
    expect(p.approval.scopesOffered).toContain("site");
    expect(owner.events.filter((e) => e.event === "approval.created")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 450));
    await owner.call("approvals.answer", {
      approvalId: p.approval.id,
      answerToken: p.answerToken,
      decision: "approve",
      scope: "site",
      presence: {
        kind: "webauthn",
        deviceId: ownerId,
        signature: `ok:${presenceChallenge(p.approval.id, p.approval.bindingHash, p.answerToken)}`,
      },
    });
    // Then every poll reads it under that one approval.
    expect(await secret.use(async (v) => v)).toBe(PASSWORD);
    expect(await secret.use(async (v) => v.length)).toBe(PASSWORD.length);
    expect(owner.events.filter((e) => e.event === "approval.created")).toHaveLength(1);

    // Revoking the grant ends it: the next read asks again.
    const grants = await owner.call<{ grants: { id: string; kind: string }[] }>("grants.list", {});
    const grant = grants.grants.find((g) => g.kind === "credential_fill");
    await owner.call("grants.revoke", { grantId: grant?.id }, ik());
    await expect(secret.use(async (v) => v)).rejects.toMatchObject({ code: "approval_required" });
  }, 30_000);
});
