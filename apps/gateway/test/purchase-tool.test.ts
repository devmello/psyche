import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrder } from "@psyche/browser";
import { PsycheError } from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { type LinkWallet, PaymentBroker, SecretRedactor, type SpendRequest } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPurchaseTool,
  PURCHASE_TOOL,
  purchaseFields,
  toMinor,
} from "../src/compose/purchase-tool.ts";

const PAN = "4242424242424242";
const CVC = "737";
const ORIGIN = "https://shop.example";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAGE = (total: string) =>
  [
    '- text "Seller: Acme Shop"',
    "- row",
    '  - cell "Blue Mug"',
    '  - cell "1"',
    '  - cell "$12.00"',
    `- text "Total: ${total}"`,
  ].join("\n");

class Wallet implements LinkWallet {
  created = 0;
  expYear = 2031;
  deleteFile = false;
  async spendLimits() {
    return { currency: "usd", perTransaction: null, daily: null, thirtyDay: null };
  }
  async paymentMethods() {
    return [{ id: "csmrpd_1", brand: "visa", last4: "1881", nickname: null, isDefault: true }];
  }
  async create(i: { amount: number; currency: string }): Promise<SpendRequest> {
    this.created += 1;
    return this.#sr(i);
  }
  #sr(i: { amount: number; currency: string }): SpendRequest {
    return {
      id: "lsrq_t1",
      status: "approved",
      amount: i.amount,
      currency: i.currency,
      merchantName: "Acme Shop",
      merchantUrl: ORIGIN,
      approvalUrl: null,
      card: null,
      requiresAction: null,
    };
  }
  async retrieve(): Promise<SpendRequest> {
    return this.#sr({ amount: 1200, currency: "usd" });
  }
  async revealCard(_id: string, out: string): Promise<SpendRequest> {
    if (!this.deleteFile)
      writeFileSync(
        out,
        JSON.stringify({ card: { number: PAN, cvc: CVC, exp_month: 4, exp_year: this.expYear } }),
        { mode: 0o600 },
      );
    const r = await this.retrieve();
    return { ...r, card: { brand: "visa", last4: "4242", expMonth: 4, expYear: this.expYear } };
  }
  async cancel(): Promise<SpendRequest> {
    return { ...(await this.retrieve()), status: "canceled" };
  }
  async report() {}
}

function setup(opts: { page?: () => string; origin?: () => string; after?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "psyche-pay-"));
  dirs.push(home);
  const wallet = new Wallet();
  const redactor = new SecretRedactor();
  const approvals = new Map<
    string,
    {
      bindingHash: string;
      scopeGranted: "once";
      status: "approved";
      kind: "purchase";
      requestedBy: { taskId: string };
    }
  >();
  const receipts: unknown[] = [];
  const audits: unknown[] = [];
  const permissions = {
    get: async (id: string) => approvals.get(id),
    recordReceipt: async (r: unknown) => {
      receipts.push(r);
      return { id: `rcpt_${receipts.length}` };
    },
  } as never;
  const payments = new PaymentBroker({
    home,
    wallet,
    permissions,
    redactor,
    audit: { append: async (e: unknown) => void audits.push(e) } as never,
  });
  const typed: string[] = [];
  const page = opts.page ?? (() => PAGE("$12.00"));
  let clicked = false;
  const driver = {
    tabOrigin: () => (opts.origin ?? (() => ORIGIN))(),
    peekSnapshot: () => ({ text: page(), url: ORIGIN }),
    snapshot: async () => ({
      text: page(),
      refs: [
        { ref: "r1", role: "textbox", name: "Card number" },
        { ref: "r2", role: "textbox", name: "Expiry" },
        { ref: "r3", role: "textbox", name: "CVC" },
        { ref: "r4", role: "button", name: "Pay now" },
      ],
    }),
    describe: async (_t: string, ref: string) => ({
      ref,
      role: "textbox",
      name: "",
      tag: "INPUT",
      inputType: "text",
      autocomplete: { r1: "cc-number", r2: "cc-exp", r3: "cc-csc" }[ref] ?? "",
      frameOrigin: (opts.origin ?? (() => ORIGIN))(),
      inForm: true,
      submits: false,
      secure: true,
      opensPopup: false,
    }),
    fillSecret: async (
      _t: string,
      _r: string,
      secret: { use(f: (v: string) => unknown): unknown },
      _o: string,
      accepts: (e: never) => { ok: boolean },
    ) => {
      expect(
        accepts({
          tagName: "input",
          type: "text",
          autocomplete: "x",
          frameOrigin: ORIGIN,
        } as never),
      ).toBeDefined();
      await secret.use((v) => void typed.push(v));
    },
    click: async () => {
      clicked = true;
    },
    wait: async () => {},
    readText: async () => ({
      text: clicked ? (opts.after ?? "Thank you for your order. Order number: AC-1042") : "",
    }),
  };
  const tool = createPurchaseTool({
    payments,
    driver: () => driver as never,
    ownsTab: async () => {},
    calls: { context: () => ({ approvalId: "ap1" }) } as never,
    approvals: { get: async (id) => approvals.get(id) as never },
    redactor,
    test: true,
    settleMs: 0,
  });
  const params = { tabId: "t1" };
  const approve = (total = "$12.00", id = "ap1") =>
    approvals.set(id, {
      bindingHash: toolCallBindingHash(PURCHASE_TOOL, params, {
        kind: "purchase",
        bindingFields: purchaseFields(readOrder(PAGE(total), ORIGIN)),
      }),
      scopeGranted: "once",
      status: "approved",
      kind: "purchase",
      requestedBy: { taskId: "task1" },
    });
  return { tool, wallet, params, approve, typed, receipts, audits, payments, home };
}

const run = (s: ReturnType<typeof setup>) =>
  s.tool.execute("call1", s.params, new AbortController().signal, () => {});

describe("checkout.pay_with_link", () => {
  it("pays once; the model, receipt and audit see only brand and last4", async () => {
    const s = setup();
    s.approve();
    const r = await run(s);
    expect(r.output).toMatchObject({
      status: "paid",
      paidWith: { brand: "visa", last4: "4242" },
      orderNumber: "AC-1042",
    });
    expect(s.typed).toEqual([PAN, "04/31", CVC]);
    const seen = JSON.stringify([r, s.receipts, s.audits, s.payments.list()]);
    for (const secret of [PAN, CVC, "04/31"]) expect(seen).not.toContain(secret);
    // A second payment from the same approval is refused and creates no spend request.
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "approval_consumed" } });
    expect(s.wallet.created).toBe(1);
  });

  it("refuses when the total changed after approval, before any spend request", async () => {
    let total = "$12.00";
    const s = setup({ page: () => PAGE(total) });
    s.approve();
    total = "$99.00";
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "order_changed" } });
    expect(s.wallet.created).toBe(0);
  });

  it("refuses when the checkout is not on the approved merchant", async () => {
    let origin = ORIGIN;
    const s = setup({ origin: () => origin });
    s.approve();
    origin = "https://evil.example";
    await expect(run(s)).rejects.toMatchObject({
      details: { reason: expect.stringMatching(/^(origin_changed|order_changed)$/) },
    });
    expect(s.wallet.created).toBe(0);
    expect(s.typed).toEqual([]);
  });

  it("makes no spend request without an approved purchase card", async () => {
    const s = setup();
    await expect(run(s)).rejects.toBeInstanceOf(PsycheError);
    expect(s.wallet.created).toBe(0);
  });

  it("fails safe when the card file is gone or the card expired", async () => {
    const gone = setup();
    gone.wallet.deleteFile = true;
    gone.approve();
    await expect(run(gone)).rejects.toBeInstanceOf(PsycheError);
    expect(gone.typed).toEqual([]);
    const old = setup();
    old.wallet.expYear = 2020;
    old.approve();
    await expect(run(old)).rejects.toMatchObject({ details: { reason: "card_expired" } });
    expect(old.typed).toEqual([]);
  });

  it("cancels and reports unconfirmed when the page never confirms the order", async () => {
    const s = setup({ after: "Processing…" });
    s.approve();
    const r = await run(s);
    expect(r.output).toMatchObject({ status: "unconfirmed" });
    expect(JSON.stringify(r)).not.toContain(PAN);
  });

  it("reads minor units", () => {
    expect(toMinor("12.5", "USD")).toBe(1250);
    expect(toMinor("1200", "JPY")).toBe(1200);
    expect(toMinor("1.234", "USD")).toBeUndefined();
  });
});
