import { validateEventPayload, validateParams, validateResult } from "@psyche/protocol";
import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultHandlers, PaymentBroker, SecretRedactor } from "../src/index.ts";
import { makeHarness } from "./helpers.ts";

afterEach(() => clearSecrets());

describe("vault.* handlers and events", () => {
  it("serve every vault method with protocol-valid results that carry no values", async () => {
    const h = makeHarness();
    const handlers = createVaultHandlers(h.vault);
    const events: [string, unknown][] = [];
    for (const name of ["vault.locked", "vault.unlocked", "credential.updated"] as const) {
      h.vault.on(name, (p) => events.push([name, p]));
    }
    const pw = "handler-secret-pw-0001";
    registerSecret(pw, "pw");
    const call = async <M extends keyof typeof handlers>(m: M, params: unknown) => {
      const p = validateParams(m, params);
      const result = await (handlers[m] as (p: unknown) => Promise<unknown>)(p);
      validateResult(m, result);
      return result as Awaited<ReturnType<(typeof handlers)[M]>>;
    };
    expect((await call("vault.status", {})).status.state).toBe("uninitialized");
    await expect(call("vault.setup", { slot: "safe_storage" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    const { recoveryKey } = await call("vault.setup", { slot: "keychain" });
    registerSecret(recoveryKey, "recovery");
    await call("vault.confirmRecovery", { lastGroup: recoveryKey.split("-").at(-1) });
    const { credential } = await call("vault.add", {
      kind: "login",
      name: "Site",
      bindings: [{ origin: "https://site.example" }],
      secret: { username: "pat", password: pw },
    });
    await call("vault.update", { credentialId: credential.id, name: "Site 2" });
    const imported = await call("vault.import", {
      format: "chrome",
      csv: "name,url,username,password\nx,https://x.example,u,imported-pw-0002\n",
    });
    expect(imported.imported).toHaveLength(1);
    expect((await call("vault.list", {})).credentials).toHaveLength(2);
    expect((await call("vault.list", { kind: "note" })).credentials).toHaveLength(0);
    await call("vault.get", { credentialId: credential.id });
    expect((await call("vault.uses", { credentialId: credential.id })).uses).toEqual([]);
    await call("vault.lock", {});
    await call("vault.unlock", { reason: "UI" });
    await call("vault.unlock", { reason: "UI", recoveryKey });
    expect((await call("vault.delete", { credentialId: credential.id })).deleted).toBe(true);
    await expect(call("vault.get", { credentialId: credential.id })).rejects.toMatchObject({
      code: "not_found",
    });
    for (const [name, payload] of events) validateEventPayload(name, payload);
    expect(events.map(([n]) => n)).toEqual(
      expect.arrayContaining(["vault.unlocked", "vault.locked", "credential.updated"]),
    );
    assertNoSecrets(events, "vault events");
    assertNoSecrets(await h.audit.list(), "audit");
    h.cleanup();
  });
});

describe("vault.linkExternal and vault.payments.* (Settings → Credentials)", () => {
  it("links a 1Password item by reference and reports where each item lives", async () => {
    const h = makeHarness({
      overrides: {
        onePassword: {
          kind: "cli",
          unavailableReason: async () => null,
          readField: async () => "op-value-123456",
        },
      },
    });
    const handlers = createVaultHandlers(h.vault);
    await h.vault.setup();
    const params = validateParams("vault.linkExternal", {
      source: "1password",
      kind: "login",
      name: "GitHub (1Password)",
      bindings: [{ origin: "https://github.com" }],
      ref: { vault: "Work", item: "GitHub" },
    });
    const { credential } = await handlers["vault.linkExternal"](params);
    validateResult("vault.linkExternal", { credential });
    expect(credential.backend).toBe("1password");
    await h.vault.add({
      kind: "note",
      name: "Wifi",
      bindings: [],
      secret: { text: "wifi-pass-123456" },
    });
    const listed = await handlers["vault.list"]({});
    validateResult("vault.list", listed);
    expect(listed.credentials.map((c) => c.backend).sort()).toEqual(["1password", "vault"]);
    h.cleanup();
  });

  it("answers unavailable without Stripe Link, and lists payments and methods with it", async () => {
    const h = makeHarness();
    await h.vault.setup();
    await expect(createVaultHandlers(h.vault)["vault.payments.list"]({})).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "payments_not_configured" },
    });
    const wallet = {
      spendLimits: async () => ({
        currency: "usd",
        perTransaction: 50_000,
        daily: null,
        thirtyDay: null,
      }),
      paymentMethods: async () => [
        { id: "csmrpd_v1", brand: "visa", last4: "1881", nickname: null, isDefault: true },
      ],
      create: async (i: {
        amount: number;
        currency: string;
        merchantName: string;
        merchantUrl: string;
      }) => ({
        id: "lsrq_h1",
        status: "pending_approval" as const,
        amount: i.amount,
        currency: i.currency,
        merchantName: i.merchantName,
        merchantUrl: i.merchantUrl,
        approvalUrl: null,
        card: null,
        requiresAction: null,
      }),
      retrieve: async () => {
        throw new Error("unused");
      },
      revealCard: async () => {
        throw new Error("unused");
      },
      cancel: async () => {
        throw new Error("unused");
      },
      report: async () => {},
    };
    const payments = new PaymentBroker({
      home: h.home,
      wallet: wallet as never,
      permissions: h.permissions,
      redactor: new SecretRedactor(),
      clock: h.clock,
    });
    const updates: string[] = [];
    payments.onUpdate((p) => updates.push(`${p.spendRequestId}:${p.status}`));
    const input = {
      merchantName: "Stand Shop B",
      merchantUrl: "https://shop-b.example/checkout",
      amount: 2900,
      currency: "usd",
      lineItems: [{ name: "Laptop stand", quantity: 1, unitAmount: 2900 }],
    };
    const issued = await payments.requestPurchase(input, {
      requestedBy: { runId: null, taskId: "task_1", threadId: null },
      taint: false,
    });
    h.clock.advance(500);
    await h.permissions.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: "dev_desktop", surface: "desktop" },
    });
    await payments.authorize(issued.approval.id, input);
    const handlers = createVaultHandlers(h.vault, { payments });
    const listed = await handlers["vault.payments.list"]({ taskId: "task_1" });
    validateResult("vault.payments.list", listed);
    expect(listed.payments).toEqual([
      expect.objectContaining({
        spendRequestId: "lsrq_h1",
        merchantHost: "shop-b.example",
        amount: 2900,
        payment: { state: "none", held: 0, captured: 0, refunded: 0 },
        fundingSource: { brand: "visa", last4: "1881" },
      }),
    ]);
    expect((await handlers["vault.payments.list"]({ taskId: "task_other" })).payments).toEqual([]);
    const methods = await handlers["vault.payments.methods"]({});
    validateResult("vault.payments.methods", methods);
    expect(methods.methods[0]).toMatchObject({ last4: "1881", isDefault: true });
    expect(updates).toEqual(["lsrq_h1:pending_approval"]);
    validateEventPayload("vault.payment.updated", { payment: listed.payments[0] });
    h.cleanup();
  });
});
