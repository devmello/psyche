import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventName, EventPayload, LinkPaymentMethod } from "@psyche/protocol";
import { FakeAuditLog, FakeClock, FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import {
  type LinkWallet,
  type PaymentMethod,
  SecretRedactor,
  type SpendRequest,
  type SpendRequestInput,
  type Vault,
} from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composePayments, paymentsSetupFromEnv } from "../src/compose/payments.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient } from "./helpers.ts";

const TEST_ARGON2 = { memory: 64, passes: 1, parallelism: 1 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "psyche-gw-pay-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A Link wallet in test mode: one default Visa, spend requests in memory, no card reveal. */
class TestWallet implements LinkWallet {
  failWith: string | null = null;
  #n = 0;
  async spendLimits() {
    return { currency: "usd", perTransaction: 50_000, daily: 50_000, thirtyDay: null };
  }
  async paymentMethods(): Promise<PaymentMethod[]> {
    if (this.failWith !== null) throw new Error(this.failWith);
    return [
      { id: "csmrpd_visa1881", brand: "visa", last4: "1881", nickname: null, isDefault: true },
    ];
  }
  async create(input: SpendRequestInput): Promise<SpendRequest> {
    this.#n += 1;
    return {
      id: `lsrq_test${this.#n}`,
      status: "pending_approval",
      amount: input.amount,
      currency: input.currency,
      merchantName: input.merchantName,
      merchantUrl: input.merchantUrl,
      approvalUrl: `https://app.link.com/approve/lsrq_test${this.#n}`,
      card: null,
      requiresAction: null,
    };
  }
  async retrieve(): Promise<SpendRequest> {
    throw new Error("not used");
  }
  async revealCard(): Promise<SpendRequest> {
    throw new Error("not used");
  }
  async cancel(): Promise<SpendRequest> {
    throw new Error("not used");
  }
  async report(): Promise<void> {}
}

const PURCHASE = {
  merchantName: "Stripe Press",
  merchantUrl: "https://press.stripe.com/checkout",
  amount: 3500,
  currency: "usd",
  lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3500 }],
};

describe("payments part (G12 in the Gateway)", () => {
  it("reads the Link CLI path from the environment", () => {
    expect(paymentsSetupFromEnv({})).toEqual({});
    expect(paymentsSetupFromEnv({ PSYCHE_LINK_CLI: " /opt/link/cli.js " })).toEqual({
      linkCli: "/opt/link/cli.js",
    });
  });

  it("adds nothing without a wallet", () => {
    const part = composePayments({})({ home: tmpHome() } as ComposeServices);
    expect(part).toEqual({});
  });

  it("fans every spend-record change out as vault.payment.updated, until stopped", async () => {
    const clock = new FakeClock();
    const permissions = new FakePermissionBroker({ clock });
    const published: { event: EventName; payload: unknown }[] = [];
    const services = {
      home: tmpHome(),
      clock,
      broker: permissions,
      redactor: new SecretRedactor(),
      audit: new FakeAuditLog({ clock }),
      vault: {} as Vault,
      publish: <E extends EventName>(event: E, payload: EventPayload<E>) => {
        published.push({ event, payload });
      },
    } as unknown as ComposeServices;
    const part = composePayments({ wallet: new TestWallet(), sweepMs: 60_000 })(services);
    const payments = part.payments;
    if (payments === undefined) throw new Error("no broker");
    part.start?.({} as never);

    const issued = await payments.requestPurchase(PURCHASE, {
      requestedBy: { runId: null, taskId: "task_buy", threadId: null, agent: "Pip" },
      taint: false,
    });
    clock.advance(500);
    await permissions.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: "dev_desktop", surface: "desktop" },
    });
    await payments.authorize(issued.approval.id, PURCHASE);

    expect(published.map((p) => p.event)).toContain("vault.payment.updated");
    const last = published.at(-1)?.payload as EventPayload<"vault.payment.updated">;
    expect(last.payment).toMatchObject({
      spendRequestId: "lsrq_test1",
      merchantHost: "press.stripe.com",
      amount: 3500,
      currency: "usd",
    });
    expect(payments.list()).toHaveLength(1);

    await part.stop?.();
    const count = published.length;
    await payments.cancel("lsrq_test1").catch(() => undefined);
    expect(published).toHaveLength(count);
  });
});

describe("vault.payments.* in the composed Gateway", () => {
  async function boot(wallet?: LinkWallet): Promise<ComposedGateway> {
    const home = tmpHome();
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const composed = await composeGateway({
      env: {},
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: TEST_ARGON2 },
      parts: wallet === undefined ? [] : [composePayments({ wallet })],
    });
    cleanups.push(() => composed.stop("test"));
    return composed;
  }

  it("answers payments_not_configured without Stripe Link", async () => {
    const composed = await boot();
    const admin = await adminClient(composed.gateway);
    cleanups.push(() => admin.close());
    const res = await admin.request("vault.payments.methods", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({
      code: "unavailable",
      details: { reason: "payments_not_configured" },
    });
  });

  it("lists the owner's Link payment methods and spends", async () => {
    const wallet = new TestWallet();
    const composed = await boot(wallet);
    const admin = await adminClient(composed.gateway);
    cleanups.push(() => admin.close());
    const methods = await admin.call<{ methods: LinkPaymentMethod[] }>(
      "vault.payments.methods",
      {},
    );
    expect(methods.methods).toEqual([
      { id: "csmrpd_visa1881", brand: "visa", last4: "1881", nickname: null, isDefault: true },
    ]);
    const list = await admin.call<{ payments: unknown[] }>("vault.payments.list", {});
    expect(list.payments).toEqual([]);

    // The CLI's message never reaches the client.
    wallet.failWith = "auth failed for owner@example.com";
    const failed = await admin.request("vault.payments.methods", {});
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatchObject({
      code: "unavailable",
      details: { reason: "link_unavailable" },
    });
    expect(JSON.stringify(failed.error)).not.toContain("owner@example.com");
  });
});
