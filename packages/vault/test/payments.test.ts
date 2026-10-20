import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoSecrets,
  clearSecrets,
  FakeAuditLog,
  FakeClock,
  FakePermissionBroker,
  registerSecret,
} from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CdpSession,
  type FocusedElement,
  LinkCliWallet,
  type LinkWallet,
  PaymentBroker,
  type PaymentMethod,
  type PurchaseInput,
  parsePaymentMethods,
  parseSpendRequest,
  purchaseBindingHash,
  SecretRedactor,
  type SpendRequest,
  type SpendRequestInput,
  type SpendStatus,
  spendContext,
} from "../src/index.ts";
import { tmpHome } from "./helpers.ts";
import { VISA } from "./samples.ts";

const CVC = "737";

/** Fake Link Agent Wallet: spend requests in memory, the owner's decision scripted. */
class FakeLinkWallet implements LinkWallet {
  readonly created: SpendRequestInput[] = [];
  readonly reports: { domain: string; outcome: string; spendRequestId: string; tags?: string[] }[] =
    [];
  decision: SpendStatus = "approved";
  perTransaction: number | null = 20_000;
  fileMode = 0o600;
  #requests = new Map<string, SpendRequest>();
  #n = 0;

  async spendLimits() {
    return { currency: "usd", perTransaction: this.perTransaction, daily: 50_000, thirtyDay: null };
  }

  methods: PaymentMethod[] = [
    { id: "csmrpd_visa1881", brand: "visa", last4: "1881", nickname: null, isDefault: true },
    {
      id: "csmrpd_mc5100",
      brand: "mastercard",
      last4: "5100",
      nickname: "Work card",
      isDefault: false,
    },
  ];
  async paymentMethods(): Promise<PaymentMethod[]> {
    return structuredClone(this.methods);
  }

  async create(input: SpendRequestInput): Promise<SpendRequest> {
    if (input.context.length < 100) throw new Error("context must be at least 100 characters");
    this.created.push(structuredClone(input));
    this.#n += 1;
    const sr: SpendRequest = {
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
    this.#requests.set(sr.id, sr);
    return structuredClone(sr);
  }

  async retrieve(id: string, options: { wait?: boolean } = {}): Promise<SpendRequest> {
    const sr = this.#requests.get(id);
    if (sr === undefined) throw new Error("not found");
    if (options.wait === true && sr.status === "pending_approval") sr.status = this.decision;
    return structuredClone(sr);
  }

  async revealCard(id: string, outFile: string): Promise<SpendRequest> {
    const sr = this.#requests.get(id);
    if (sr === undefined || sr.status !== "approved") throw new Error("not approved");
    if (existsSync(outFile)) throw new Error("file exists");
    writeFileSync(
      outFile,
      JSON.stringify({
        card: {
          number: VISA,
          cvc: CVC,
          exp_month: 4,
          exp_year: 2031,
          billing_address: { name: "Pat Owner", postal_code: "94110" },
        },
      }),
      { mode: this.fileMode },
    );
    sr.card = { brand: "visa", last4: VISA.slice(-4), expMonth: 4, expYear: 2031 };
    return structuredClone(sr);
  }

  async cancel(id: string): Promise<SpendRequest> {
    const sr = this.#requests.get(id);
    if (sr === undefined) throw new Error("not found");
    sr.status = "canceled";
    return structuredClone(sr);
  }

  async report(input: {
    domain: string;
    outcome: "success" | "blocked" | "abandoned";
    spendRequestId: string;
    tags?: string[];
  }) {
    this.reports.push(input);
  }
}

const PURCHASE: PurchaseInput = {
  merchantName: "Stripe Press",
  merchantUrl: "https://press.stripe.com/checkout",
  amount: 3500,
  currency: "usd",
  lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3500 }],
};
const REQ = {
  requestedBy: { runId: null, taskId: "task_buy", threadId: null, agent: "Pip" },
  taint: false,
};

let home: ReturnType<typeof tmpHome>;
let clock: FakeClock;
let permissions: FakePermissionBroker;
let audit: FakeAuditLog;
let wallet: FakeLinkWallet;
let redactor: SecretRedactor;
let broker: PaymentBroker;

beforeEach(() => {
  home = tmpHome();
  clock = new FakeClock();
  permissions = new FakePermissionBroker({ clock });
  audit = new FakeAuditLog({ clock });
  wallet = new FakeLinkWallet();
  redactor = new SecretRedactor();
  broker = new PaymentBroker({ home: home.home, wallet, permissions, redactor, audit, clock });
  registerSecret(VISA, "card");
});
afterEach(() => {
  home.cleanup();
  clearSecrets();
});

async function approve(input = PURCHASE): Promise<string> {
  const issued = await broker.requestPurchase(input, REQ);
  clock.advance(500);
  await permissions.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: "once",
    decidedBy: { deviceId: "dev_desktop", surface: "desktop" },
  });
  return issued.approval.id;
}

/** A merchant checkout page with one focused field. */
function checkout(origin: string, element: Partial<FocusedElement>) {
  const typed: string[] = [];
  let value = "";
  const el: FocusedElement = { tagName: "input", type: "text", frameOrigin: origin, ...element };
  const cdp: CdpSession = {
    async send(method, params = {}) {
      switch (method) {
        case "Page.getFrameTree":
          return {
            frameTree: { frame: { id: "F", url: `${origin}/pay`, securityOrigin: origin } },
          };
        case "Page.createIsolatedWorld":
          return { executionContextId: 1 };
        case "Runtime.evaluate":
          return { result: { objectId: "o" } };
        case "Runtime.callFunctionOn": {
          const fn = String(params.functionDeclaration);
          if (fn.includes("isConnected")) return { result: { value: true } };
          if (fn.includes("formHasPassword")) return { result: { value: el } };
          if (fn.includes("activeElement === this"))
            return { result: { value: [...value].length } };
          return { result: {} };
        }
        case "Input.insertText":
          typed.push(String(params.text));
          value += String(params.text);
          return {};
        default:
          return {};
      }
    },
  };
  return { cdp, typed };
}

describe("Stripe Link payments (G12)", () => {
  it("asks for a financial, device-only, authenticated once approval bound to the purchase", async () => {
    const issued = await broker.requestPurchase(PURCHASE, {
      ...REQ,
      surfaces: ["desktop", "telegram:42"],
    });
    expect(issued.approval).toMatchObject({
      kind: "purchase",
      sideEffect: "financial",
      deviceOnly: true,
      requiresAuthentication: true,
      scopesOffered: ["once"],
      surfaces: ["desktop"],
      summary:
        "Pay $35.00 to Stripe Press (press.stripe.com) with Stripe Link, funded by Visa •••• 1881",
    });
  });

  it("refuses amounts over Link's or the owner's limits and malformed purchases", async () => {
    await expect(
      broker.requestPurchase({ ...PURCHASE, amount: 60_000, lineItems: [] }, REQ),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      broker.requestPurchase(
        {
          ...PURCHASE,
          amount: 60_000,
          lineItems: [{ name: "x", quantity: 1, unitAmount: 60_000 }],
        },
        REQ,
      ),
    ).rejects.toMatchObject({ details: { reason: "link_limit" } });
    await expect(
      broker.requestPurchase(
        {
          ...PURCHASE,
          amount: 25_000,
          lineItems: [{ name: "x", quantity: 1, unitAmount: 25_000 }],
        },
        REQ,
      ),
    ).rejects.toMatchObject({ details: { reason: "spend_limit" } });
    await expect(
      broker.requestPurchase({ ...PURCHASE, merchantUrl: "http://press.stripe.com" }, REQ),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(broker.requestPurchase({ ...PURCHASE, amount: 35.5 }, REQ)).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("creates the spend request only for the approved purchase, with Psyche-written context", async () => {
    const apr = await approve();
    await expect(
      broker.authorize(apr, {
        ...PURCHASE,
        amount: 3600,
        lineItems: [{ name: "Working in Public", quantity: 1, unitAmount: 3600 }],
      }),
    ).rejects.toMatchObject({
      details: { reason: "approval_binding_mismatch" },
    });
    expect(wallet.created).toHaveLength(0);
    const rec = await broker.authorize(apr, PURCHASE);
    expect(rec).toMatchObject({
      status: "pending_approval",
      approvalUrl: expect.stringContaining("lsrq_test1"),
      taskId: "task_buy",
    });
    expect(wallet.created[0]?.context).toBe(spendContext(PURCHASE));
    expect(wallet.created[0]?.context.length).toBeGreaterThanOrEqual(100);
    await expect(broker.authorize(apr, PURCHASE)).rejects.toMatchObject({
      details: { reason: "approval_consumed" },
    });
  });

  it("writes the one-time card only to a 0600 file and returns brand / last4 / expiry", async () => {
    const rec = await broker.awaitCard(
      (await broker.authorize(await approve(), PURCHASE)).spendRequestId,
    );
    expect(rec.card).toEqual({ brand: "visa", last4: VISA.slice(-4), expMonth: 4, expYear: 2031 });
    const cardFile = join(home.home, "vault", "cards", `${rec.spendRequestId}.json`);
    expect(statSync(cardFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(home.home, "vault", "cards")).mode & 0o777).toBe(0o700);
    assertNoSecrets(rec, "spend record");
    for (const f of readdirSync(join(home.home, "vault", "payments"))) {
      assertNoSecrets(
        readFileSync(join(home.home, "vault", "payments", f), "utf8"),
        "payments ledger",
      );
    }
    assertNoSecrets(await audit.list(), "audit");
    expect(redactor.redact(`card ${VISA} cvc ${CVC}`)).toBe("card ••• cvc 737"); // a 3-digit CVC is too short to track
  });

  it("refuses a card file Link left readable", async () => {
    wallet.fileMode = 0o644;
    const sr = (await broker.authorize(await approve(), PURCHASE)).spendRequestId;
    await expect(broker.awaitCard(sr)).rejects.toMatchObject({ code: "internal" });
    expect(readdirSync(join(home.home, "vault", "cards"))).toEqual([]);
  });

  it("stops when the owner denies or lets the Link approval expire", async () => {
    for (const decision of ["denied", "expired"] as const) {
      wallet.decision = decision;
      const sr = (await broker.authorize(await approve(), PURCHASE)).spendRequestId;
      await expect(broker.awaitCard(sr)).rejects.toMatchObject({
        details: { reason: `link_${decision}` },
      });
      await expect(
        broker.fillCard({
          ...checkout("https://press.stripe.com", { autocomplete: "cc-number" }),
          spendRequestId: sr,
          field: "number",
        }),
      ).resolves.toMatchObject({ ok: false, reason: "no_card" });
    }
  });

  it("fills card fields on the merchant's checkout only, into the right fields", async () => {
    const sr = (
      await broker.awaitCard((await broker.authorize(await approve(), PURCHASE)).spendRequestId)
    ).spendRequestId;
    const number = checkout("https://press.stripe.com", { autocomplete: "cc-number", type: "tel" });
    expect(
      await broker.fillCard({ cdp: number.cdp, spendRequestId: sr, field: "number" }),
    ).toMatchObject({ ok: true, secureField: true });
    expect(number.typed).toEqual([VISA]);
    const exp = checkout("https://shop.press.stripe.com", { fieldName: "cc-exp" });
    expect(await broker.fillCard({ cdp: exp.cdp, spendRequestId: sr, field: "exp" })).toMatchObject(
      { ok: true },
    );
    expect(exp.typed).toEqual(["04/31"]);
    const cvc = checkout("https://press.stripe.com", { autocomplete: "cc-csc" });
    expect(await broker.fillCard({ cdp: cvc.cdp, spendRequestId: sr, field: "cvc" })).toMatchObject(
      { ok: true },
    );

    const refusals: [ReturnType<typeof checkout>, string, "number" | "cvc"][] = [
      [
        checkout("https://press-stripe.evil.test", { autocomplete: "cc-number" }),
        "merchant_mismatch",
        "number",
      ],
      [
        checkout("https://press.stripe.com", {
          autocomplete: "cc-number",
          frameOrigin: "https://js.stripe.com",
        }),
        "card_field_in_frame",
        "number",
      ],
      [
        checkout("https://press.stripe.com", { tagName: "textarea", fieldName: "comment" }),
        "not_input:textarea",
        "number",
      ],
      [checkout("https://press.stripe.com", { fieldName: "search" }), "not_number_field", "number"],
      [checkout("https://press.stripe.com", { autocomplete: "cc-number" }), "not_cvc_field", "cvc"],
    ];
    for (const [page, reason, field] of refusals) {
      expect(await broker.fillCard({ cdp: page.cdp, spendRequestId: sr, field })).toMatchObject({
        ok: false,
        reason,
      });
      expect(page.typed).toEqual([]);
    }
  });

  it("completes: shreds the card, reports to Link and records a receipt with the Link reference", async () => {
    const sr = (
      await broker.awaitCard((await broker.authorize(await approve(), PURCHASE)).spendRequestId)
    ).spendRequestId;
    const receipt = await broker.complete(sr, {
      outcome: "success",
      orderNumber: "SP-10042",
      merchantConfirmation: "conf_8812",
    });
    expect(receipt).toMatchObject({
      kind: "purchase",
      outcome: "ok",
      summary: `Paid $35.00 to Stripe Press (visa •••• ${VISA.slice(-4)})`,
      externalRefs: {
        linkSpendRequestId: sr,
        orderNumber: "SP-10042",
        merchantConfirmation: "conf_8812",
      },
    });
    assertNoSecrets(receipt, "receipt");
    expect(readdirSync(join(home.home, "vault", "cards"))).toEqual([]);
    expect(wallet.reports).toEqual([
      { domain: "press.stripe.com", outcome: "success", spendRequestId: sr },
    ]);
    expect((await audit.list()).map((e) => e.kind)).toEqual(
      expect.arrayContaining(["purchase.requested", "purchase.captured"]),
    );
    // The card can no longer be filled.
    const page = checkout("https://press.stripe.com", { autocomplete: "cc-number" });
    expect(
      await broker.fillCard({ cdp: page.cdp, spendRequestId: sr, field: "number" }),
    ).toMatchObject({ ok: false, reason: "no_card" });
  });

  it("sweeps card files after their TTL and survives a restart", async () => {
    const sr = (
      await broker.awaitCard((await broker.authorize(await approve(), PURCHASE)).spendRequestId)
    ).spendRequestId;
    const again = new PaymentBroker({
      home: home.home,
      wallet,
      permissions,
      redactor,
      clock,
      cardTtlMs: 60_000,
    });
    expect(again.get(sr)?.status).toBe("approved");
    expect(again.sweep()).toBe(0);
    clock.advance(61_000);
    expect(again.sweep()).toBe(1);
    expect(readdirSync(join(home.home, "vault", "cards"))).toEqual([]);
  });

  it("cancel shreds the card and cancels in Link", async () => {
    const sr = (
      await broker.awaitCard((await broker.authorize(await approve(), PURCHASE)).spendRequestId)
    ).spendRequestId;
    expect((await broker.cancel(sr)).status).toBe("canceled");
    expect(readdirSync(join(home.home, "vault", "cards"))).toEqual([]);
  });
});

describe("Link CLI adapter", () => {
  it("runs link-cli without a shell, JSON output, card only to --output-file", async () => {
    const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
    const responses: unknown[] = [
      {
        id: "lsrq_abc1",
        status: "pending_approval",
        amount: 3500,
        currency: "usd",
        merchant_name: "Stripe Press",
        merchant_url: "https://press.stripe.com",
        approval_url: "https://app.link.com/a/lsrq_abc1",
      },
      {
        id: "lsrq_abc1",
        status: "approved",
        amount: 3500,
        currency: "usd",
        card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 },
        card_output_file: "/x",
      },
    ];
    const wallet = new LinkCliWallet({
      cli: "/opt/link-cli/dist/cli.js",
      env: { LINK_AUTH_FILE: "/home/p/.psyche/vault/link-auth.json" },
      run: async (file, args, env) => {
        calls.push({ file, args, env });
        return JSON.stringify(responses.shift());
      },
    });
    const sr = await wallet.create({ ...PURCHASE, context: spendContext(PURCHASE) });
    expect(sr).toMatchObject({
      id: "lsrq_abc1",
      status: "pending_approval",
      approvalUrl: "https://app.link.com/a/lsrq_abc1",
    });
    expect(calls[0]?.file).toBe(process.execPath);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        "/opt/link-cli/dist/cli.js",
        "spend-request",
        "create",
        "--request-approval",
        "--format",
        "json",
        "--amount",
        "3500",
        "--currency",
        "usd",
      ]),
    );
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["HOME", "LINK_AUTH_FILE", "PATH"]);
    await wallet.revealCard("lsrq_abc1", "/home/p/.psyche/vault/cards/lsrq_abc1.json");
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining([
        "--include",
        "card",
        "--output-file",
        "/home/p/.psyche/vault/cards/lsrq_abc1.json",
      ]),
    );
  });

  it("keeps only the masked card and rejects malformed ids; failures carry no output", async () => {
    expect(
      parseSpendRequest({
        id: "lsrq_1",
        status: "approved",
        card: { brand: "visa", last4: "4242", number: "x" },
      }).card,
    ).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: 0,
      expYear: 0,
    });
    expect(() => parseSpendRequest({ id: "../../etc" })).toThrow();
    const failing = new LinkCliWallet({
      cli: "/usr/local/bin/link-cli",
      run: async () => {
        throw Object.assign(new Error(`stderr: card ${VISA}`), { exitCode: 2 });
      },
    });
    const err = await failing.retrieve("lsrq_1").catch((e: unknown) => e);
    expect(String(err) + JSON.stringify(err)).not.toContain(VISA);
  });
});

describe("purchases the agent loop already dispatched", () => {
  /** A loop-issued card: its own binding hash, approved and consumed by the loop's verifyBinding. */
  async function loopApproval(kind: "purchase" | "connector_action" = "purchase", consume = true) {
    const hash = "sha256:loop-recipe-hash-for-these-args";
    const issued = await permissions.requestApproval({
      kind,
      summary: "Hand off cart at Stand Shop B",
      details: { tool: "shop.pay_with_link" },
      bindingHash: hash,
      grantKey: "purchase|shop-b.example",
      requestedBy: REQ.requestedBy,
      sideEffect: kind === "purchase" ? "financial" : "write",
      surfaces: ["desktop"],
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
    if (consume) expect((await permissions.verifyBinding(issued.approval.id, hash)).ok).toBe(true);
    return { id: issued.approval.id, hash };
  }

  it("creates one spend request for a dispatched purchase approval with the same binding", async () => {
    const { id, hash } = await loopApproval();
    const rec = await broker.authorizeDispatched(id, PURCHASE, hash);
    expect(rec).toMatchObject({ approvalId: id, status: "pending_approval", taskId: "task_buy" });
    await expect(broker.authorizeDispatched(id, PURCHASE, hash)).rejects.toMatchObject({
      details: { reason: "approval_consumed" },
    });
    expect(wallet.created).toHaveLength(1);
  });

  it("refuses another hash, another kind, or an approval that is not approved", async () => {
    const a = await loopApproval();
    await expect(broker.authorizeDispatched(a.id, PURCHASE, "sha256:other")).rejects.toMatchObject({
      details: { reason: "approval_binding_mismatch" },
    });
    const b = await loopApproval("connector_action");
    await expect(broker.authorizeDispatched(b.id, PURCHASE, b.hash)).rejects.toMatchObject({
      details: { reason: "approval_wrong_kind" },
    });
    await expect(broker.authorizeDispatched("apr_missing", PURCHASE, "x")).rejects.toMatchObject({
      details: { reason: "approval_not_found" },
    });
    const pending = await permissions.requestApproval({
      kind: "purchase",
      summary: "x",
      details: {},
      bindingHash: "sha256:p",
      grantKey: "purchase|x",
      requestedBy: REQ.requestedBy,
      sideEffect: "financial",
      surfaces: ["desktop"],
      taint: false,
    });
    await expect(
      broker.authorizeDispatched(pending.approval.id, PURCHASE, "sha256:p"),
    ).rejects.toMatchObject({
      details: { reason: "approval_pending" },
    });
    expect(wallet.created).toHaveLength(0);
  });
});

describe("funding source in the purchase binding", () => {
  it("shows and binds the Link payment method's brand and last4", async () => {
    const issued = await broker.requestPurchase(
      { ...PURCHASE, paymentMethodId: "csmrpd_mc5100" },
      REQ,
    );
    expect(issued.approval.summary).toContain("funded by Mastercard •••• 5100");
    expect(issued.approval.details).toMatchObject({
      paymentMethod: { id: "csmrpd_mc5100", last4: "5100" },
    });
    expect(
      purchaseBindingHash(PURCHASE, { id: "csmrpd_mc5100", brand: "mastercard", last4: "5100" }),
    ).not.toBe(
      purchaseBindingHash(PURCHASE, { id: "csmrpd_visa1881", brand: "visa", last4: "1881" }),
    );
  });

  it("refuses to pay when the default funding card changed after the approval", async () => {
    const apr = await approve();
    wallet.methods = wallet.methods.map((m) => ({ ...m, isDefault: m.id === "csmrpd_mc5100" }));
    await expect(broker.authorize(apr, PURCHASE)).rejects.toMatchObject({
      details: { reason: "approval_binding_mismatch" },
    });
    expect(wallet.created).toHaveLength(0);
  });

  it("creates the spend request on the approved payment method and records it", async () => {
    const rec = await broker.authorize(await approve(), PURCHASE);
    expect(wallet.created[0]?.paymentMethodId).toBe("csmrpd_visa1881");
    expect(rec.fundingSource).toEqual({ id: "csmrpd_visa1881", brand: "visa", last4: "1881" });
    expect(rec.payment.state).toBe("none");
  });

  it("refuses when Link has no payment method", async () => {
    wallet.methods = [];
    await expect(broker.requestPurchase(PURCHASE, REQ)).rejects.toMatchObject({
      details: { reason: "no_payment_method" },
    });
  });
});

describe("payment lifecycle: hold, capture, refund, decline, release", () => {
  const ready = async () =>
    (await broker.awaitCard((await broker.authorize(await approve(), PURCHASE)).spendRequestId))
      .spendRequestId;
  const kinds = async () => (await audit.list()).map((e) => e.kind);

  it("holds, then captures; the card is shredded at the hold", async () => {
    const sr = await ready();
    const hold = await broker.hold(sr, {
      holdRef: "HOLD-77",
      expiresAt: "2026-10-21T08:30:00.000Z",
    });
    expect(hold).toMatchObject({
      kind: "purchase.hold",
      outcome: "ok",
      externalRefs: { linkSpendRequestId: sr, holdRef: "HOLD-77" },
    });
    expect(readdirSync(join(home.home, "vault", "cards"))).toEqual([]);
    const page = checkout("https://press.stripe.com", { autocomplete: "cc-number" });
    expect(
      await broker.fillCard({ cdp: page.cdp, spendRequestId: sr, field: "number" }),
    ).toMatchObject({ reason: "no_card" });
    const capture = await broker.capture(sr, {
      orderNumber: "SP-1",
      merchantConfirmation: "conf_1",
    });
    expect(capture).toMatchObject({
      kind: "purchase",
      outcome: "ok",
      externalRefs: { orderNumber: "SP-1" },
    });
    expect(broker.get(sr)?.payment).toMatchObject({
      state: "captured",
      held: 3500,
      captured: 3500,
    });
    expect(await kinds()).toEqual(expect.arrayContaining(["purchase.held", "purchase.captured"]));
    const held = (await audit.list()).find((e) => e.kind === "purchase.held");
    expect(held?.data).toMatchObject({ receiptId: hold.id, receiptKind: "purchase.hold" });
    assertNoSecrets([hold, capture, await audit.list()], "lifecycle receipts");
  });

  it("refuses holds and captures above what was approved or held", async () => {
    const sr = await ready();
    await expect(broker.hold(sr, { amount: 3600, holdRef: "H" })).rejects.toMatchObject({
      details: { reason: "amount_increase" },
    });
    await broker.hold(sr, { amount: 3000, holdRef: "H" });
    await expect(broker.capture(sr, { amount: 3100 })).rejects.toMatchObject({
      details: { reason: "amount_increase" },
    });
    await broker.capture(sr, { amount: 3000, orderNumber: "SP-2" });
    expect(broker.get(sr)?.payment.captured).toBe(3000);
  });

  it("refunds partly, then fully, never more than captured", async () => {
    const sr = await ready();
    await expect(broker.refund(sr, { refundRef: "re_0" })).rejects.toMatchObject({
      code: "conflict",
    });
    await broker.capture(sr, { orderNumber: "SP-3" });
    const part = await broker.refund(sr, {
      amount: 1000,
      refundRef: "re_1",
      reason: "one item missing",
    });
    expect(part).toMatchObject({ kind: "purchase.refund", externalRefs: { refundRef: "re_1" } });
    expect(broker.get(sr)?.payment).toMatchObject({ state: "partially_refunded", refunded: 1000 });
    await expect(broker.refund(sr, { amount: 2600, refundRef: "re_x" })).rejects.toMatchObject({
      details: { reason: "refund_exceeds_capture" },
    });
    await broker.refund(sr, { refundRef: "re_2" });
    expect(broker.get(sr)?.payment).toMatchObject({ state: "refunded", refunded: 3500 });
    expect(await kinds()).toContain("purchase.refunded");
  });

  it("records a decline: nothing charged, Link told, no capture afterwards", async () => {
    const sr = await ready();
    const declined = await broker.decline(sr, { code: "card_declined" });
    expect(declined).toMatchObject({
      kind: "purchase.declined",
      outcome: "failed",
      externalRefs: { declineCode: "card_declined" },
    });
    expect(wallet.reports.at(-1)).toMatchObject({ outcome: "blocked", tags: ["payment_declined"] });
    await expect(broker.capture(sr, { orderNumber: "x" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(broker.get(sr)?.payment).toMatchObject({ state: "declined", captured: 0 });
  });

  it("releases a hold without a charge", async () => {
    const sr = await ready();
    await broker.hold(sr, { holdRef: "HOLD-9" });
    const released = await broker.releaseHold(sr, { reason: "owner chose another flight" });
    expect(released).toMatchObject({ kind: "purchase.hold_released", outcome: "ok" });
    expect(broker.get(sr)?.payment).toMatchObject({ state: "released", held: 0, captured: 0 });
    await expect(broker.capture(sr, {})).rejects.toMatchObject({ code: "conflict" });
  });

  it("complete() maps onto the lifecycle", async () => {
    const declined = await ready();
    expect(
      (await broker.complete(declined, { outcome: "blocked", tags: ["payment_declined"] })).kind,
    ).toBe("purchase.declined");
    const held = await ready();
    await broker.hold(held, { holdRef: "H" });
    expect((await broker.complete(held, { outcome: "abandoned" })).kind).toBe(
      "purchase.hold_released",
    );
  });
});

describe("parsePaymentMethods", () => {
  it("maps the CLI's list (plain or {data}) and keeps only redacted fields", () => {
    const raw = [
      {
        id: "csmrpd_a1",
        type: "card",
        card: { brand: "visa", last4: "1881", number: "x" },
        is_default: true,
      },
      {
        id: "csmrpd_b2",
        type: "bank_account",
        bank_account: { last4: "6789" },
        nickname: "Checking",
      },
      { id: "../bad", card: { last4: "0000" } },
    ];
    expect(parsePaymentMethods(raw)).toEqual([
      { id: "csmrpd_a1", brand: "visa", last4: "1881", nickname: null, isDefault: true },
      {
        id: "csmrpd_b2",
        brand: "bank_account",
        last4: "6789",
        nickname: "Checking",
        isDefault: false,
      },
    ]);
    expect(parsePaymentMethods({ data: raw.slice(0, 1) })).toHaveLength(1);
  });
});
