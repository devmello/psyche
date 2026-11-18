import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMoney, readOrder } from "@psyche/browser";
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
  cancelled = 0;
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
    this.cancelled += 1;
    return { ...(await this.retrieve()), status: "canceled" };
  }
  async report() {}
}

function setup(
  opts: {
    page?: () => string;
    snapshotText?: (n: number) => string;
    origin?: () => string;
    after?: string;
    frameOrigin?: string;
    disconnected?: boolean;
    closeAfterClick?: boolean;
    /** Audit kind whose write throws (after the record is saved). */
    auditThrows?: string;
  } = {},
) {
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
    audit: {
      append: async (e: { kind?: string }) => {
        if (e.kind === opts.auditThrows) throw new Error("audit disk full");
        audits.push(e);
      },
    } as never,
  });
  const typed: string[] = [];
  const page = opts.page ?? (() => PAGE("$12.00"));
  let clicked = false;
  let maskEnded = 0;
  const fillOptions: unknown[] = [];
  let snaps = 0;
  const nextSnap = () => {
    snaps += 1;
    return snaps;
  };
  const driver = {
    tabOrigin: () => (opts.origin ?? (() => ORIGIN))(),
    peekSnapshot: () => ({ text: page(), url: ORIGIN }),
    snapshot: async () => ({
      text: opts.snapshotText === undefined ? page() : opts.snapshotText(nextSnap()),
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
      frameOrigin: opts.frameOrigin ?? (opts.origin ?? (() => ORIGIN))(),
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
      options?: { maskDocument?: boolean },
    ) => {
      fillOptions.push(options);
      // The live-element check handed to the browser refuses a non-card element.
      expect(accepts({ tagName: "div", frameOrigin: ORIGIN } as never).ok).toBe(false);
      await secret.use((v) => void typed.push(v));
    },
    click: async () => {
      clicked = true;
    },
    endDocumentMask: () => {
      maskEnded += 1;
    },
    // A closed tab makes the real driver throw synchronously, not reject.
    wait: () => {
      if (opts.closeAfterClick === true && clicked) throw new PsycheError("not_found", "no tab");
      return Promise.resolve();
    },
    readText: () => {
      if (opts.closeAfterClick === true && clicked) throw new PsycheError("not_found", "no tab");
      return Promise.resolve({
        text: clicked ? (opts.after ?? "Thank you for your order. Order number: AC-1042") : "",
      });
    },
  };
  const tool = createPurchaseTool({
    payments,
    driver: () => (opts.disconnected === true ? undefined : (driver as never)),
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
  return {
    maskEnded: () => maskEnded,
    fillOptions,
    tool,
    wallet,
    params,
    approve,
    typed,
    receipts,
    audits,
    payments,
    home,
    approvals,
    redactor,
  };
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

  it.each([
    ["$12,00"],
    ["12,50 €"],
    ["1.299,00 €"],
    ["$1,2345"],
    ["HK$100.00"],
    ["NZ$12.00"],
    ["MX$120.00"],
    ["S$15.00"],
    ["R$ 50.00"],
    ["$1 234.00"],
    ["1 234.00 €"],
    ["€12.00 USD"],
    ["HK $100.00"],
    ["HK\u200b$100.00"],
    ["НК$100.00"],
    ["$100.00 HKD"],
    ["(CAD) $12.00"],
    ["-$12.00"],
    ["($12.00)"],
    ["$1\u2009234.00"],
  ])("refuses the ambiguous total %s before any spend request", async (total) => {
    const s = setup({ page: () => PAGE(total) });
    s.approve(total);
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "total_unreadable" } });
    expect(s.wallet.created).toBe(0);
  });

  it("reads prefixed dollars as their own currency and shows the charged amount on the card", () => {
    expect(parseMoney("CA$15.00")).toEqual({ amount: "15.00", currency: "CAD" });
    expect(parseMoney("A$15.00")).toEqual({ amount: "15.00", currency: "AUD" });
    expect(parseMoney("$1,299.50")).toEqual({ amount: "1299.50", currency: "USD" });
    const s = setup();
    const d = s.tool.describeCall?.(s.params);
    expect(d?.summary).toContain("US$12.00 (the page says Total: $12.00)");
    expect(d?.summary).toContain("shop.example");
    expect(d?.bindingFields).toMatchObject({ amountMinor: 1200, currency: "USD" });
  });

  it("quotes the page's whole total and never shows an unknown dollar as a known one", () => {
    const s = setup({ page: () => '- text "Total: HK$100.00"' });
    const summary = s.tool.describeCall?.(s.params).summary ?? "";
    expect(summary).toContain("could not be read (the page says Total: HK$100.00)");
    expect(summary).not.toContain("US$");
    expect(parseMoney("Total: €12.00 USD")).toEqual({});
    expect(parseMoney("1 234.00 €")).toEqual({ currency: "EUR" });
  });

  it("records unconfirmed and ends the Link request when the tab closes after Pay", async () => {
    const s = setup({ closeAfterClick: true });
    s.approve();
    const r = await run(s);
    expect(r.output).toMatchObject({ status: "unconfirmed" });
    expect(r.receiptId).toBeDefined();
    expect(JSON.stringify(s.receipts)).toContain("purchase.unconfirmed");
    expect(s.wallet.cancelled).toBe(1);
    expect(existsSync(join(s.home, "vault", "cards", "lsrq_t1.json"))).toBe(false);
  });

  it("records unconfirmed for a card left revealed by a restart", async () => {
    const s = setup();
    s.approvals.set("ap3", {
      bindingHash: "sha256:y",
      scopeGranted: "once",
      status: "approved",
      kind: "purchase",
      requestedBy: { taskId: "t" },
    });
    const spend = await s.payments.authorizeDispatched(
      "ap3",
      {
        merchantName: "shop.example",
        merchantUrl: ORIGIN,
        amount: 1200,
        currency: "usd",
        lineItems: [{ name: "Order", quantity: 1, unitAmount: 1200 }],
      },
      "sha256:y",
    );
    await s.payments.awaitCard(spend.spendRequestId);
    expect(await s.payments.recoverOrphans()).toBe(1);
    expect(JSON.stringify(s.receipts)).toContain("purchase.unconfirmed");
    expect(s.wallet.cancelled).toBe(1);
    expect(existsSync(join(s.home, "vault", "cards", `${spend.spendRequestId}.json`))).toBe(false);
  });

  it("quotes the whole total row and refuses a currency code in another cell", async () => {
    const row = ["- row", '  - cell "Total"', '  - cell "CAD"', '  - cell "$12.00"'].join("\n");
    const s = setup({ page: () => row });
    expect(s.tool.describeCall?.(s.params).summary).toContain(
      "could not be read (the page says Total | CAD | $12.00)",
    );
    s.approvals.set("ap1", {
      bindingHash: toolCallBindingHash(PURCHASE_TOOL, s.params, {
        kind: "purchase",
        bindingFields: purchaseFields(readOrder(row, ORIGIN)),
      }),
      scopeGranted: "once",
      status: "approved",
      kind: "purchase",
      requestedBy: { taskId: "task1" },
    });
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "total_unreadable" } });
    expect(s.wallet.created).toBe(0);
  });

  it("reports a captured payment as paid when only the audit write failed, and never cancels it", async () => {
    const s = setup({ auditThrows: "purchase.captured" });
    s.approve();
    const r = await run(s);
    expect(r.output).toMatchObject({ status: "paid", orderNumber: "AC-1042" });
    expect(s.wallet.cancelled).toBe(0);
    await expect(s.payments.cancel("lsrq_t1")).rejects.toMatchObject({
      details: { reason: "payment_captured" },
    });
  });

  it("masks the checkout document for the card fill and leaves it on when the payment ends", async () => {
    const s = setup();
    s.approve();
    await run(s);
    expect(s.fillOptions).toEqual([
      { maskDocument: true },
      { maskDocument: true },
      { maskDocument: true },
    ]);
    expect(s.maskEnded()).toBe(0);
    const unconfirmed = setup({ after: "Processing…" });
    unconfirmed.approve();
    await run(unconfirmed);
    expect(unconfirmed.maskEnded()).toBe(0);
  });

  it.each([
    ["Total | $120.00 | $12.00", ["Total", "$120.00", "$12.00"]],
    ["Total | Was $120.00 | $12.00", ["Total", "Was $120.00", "$12.00"]],
    ["Total | 2 | $24.00", ["Total", "2", "$24.00"]],
  ])("binds the total cell's amount in the row %s", (_name, cells) => {
    const row = ["- row", ...cells.map((c) => `  - cell "${c}"`)].join("\n");
    const order = readOrder(row, ORIGIN);
    const want = cells[2] === "$24.00" ? 2400 : 1200;
    expect(purchaseFields(order)).toMatchObject({ amountMinor: want, currency: "USD" });
    expect(order.totalText).toBe(cells.join(" | "));
  });

  it("says when items could not be read", () => {
    const s = setup({ page: () => '- text "Total: $12.00"' });
    expect(s.tool.describeCall?.(s.params).summary).toContain("items not checked on this page");
  });

  it("refuses when the order changes between Link approval and fill, and cancels", async () => {
    const s = setup({ snapshotText: (n) => PAGE(n === 1 ? "$12.00" : "$99.00") });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "order_changed" } });
    expect(s.typed).toEqual([]);
    expect(s.wallet.cancelled).toBe(1);
  });

  it("refuses when the order changes between fill and click, and cancels", async () => {
    const s = setup({ snapshotText: (n) => PAGE(n <= 2 ? "$12.00" : "$99.00") });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "order_changed" } });
    expect(s.wallet.cancelled).toBe(1);
  });

  it("ends the Link request when the merchant declines", async () => {
    const s = setup({ after: "Your card was declined." });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({ details: { reason: "payment_declined" } });
    expect(s.wallet.cancelled).toBe(1);
  });

  it("records an unconfirmed receipt, not a capture, when the page never confirms", async () => {
    const s = setup({ after: "Processing…" });
    s.approve();
    await run(s);
    expect(JSON.stringify(s.receipts)).toContain("purchase.unconfirmed");
    expect(JSON.stringify(s.receipts)).not.toContain('"kind":"purchase","outcome":"ok"');
    expect(s.wallet.cancelled).toBe(1);
  });

  it("refuses a card field in another frame and an http checkout", async () => {
    const frame = setup({ frameOrigin: "https://js.stripe.com" });
    frame.approve();
    await expect(run(frame)).rejects.toMatchObject({ details: { reason: "card_field_in_frame" } });
    expect(frame.typed).toEqual([]);
    expect(frame.wallet.cancelled).toBe(1);
    const http = setup({ origin: () => "http://shop.example" });
    http.approve();
    await expect(run(http)).rejects.toBeInstanceOf(PsycheError);
    expect(http.wallet.created).toBe(0);
  });

  it("fails when the browser is disconnected", async () => {
    const s = setup({ disconnected: true });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({ code: "unavailable" });
    expect(s.wallet.created).toBe(0);
  });

  it("lets only one of two concurrent calls on one approval create a spend request", async () => {
    const s = setup();
    s.approve();
    const [a, b] = await Promise.allSettled([run(s), run(s)]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(s.wallet.created).toBe(1);
  });

  it("masks the CVC and expiry while in flight, and fills only the exact approved host", async () => {
    const s = setup();
    s.approvals.set("ap2", {
      bindingHash: "sha256:x",
      scopeGranted: "once",
      status: "approved",
      kind: "purchase",
      requestedBy: { taskId: "t" },
    });
    const spend = await s.payments.authorizeDispatched(
      "ap2",
      {
        merchantName: "shop.example",
        merchantUrl: ORIGIN,
        amount: 1200,
        currency: "usd",
        lineItems: [{ name: "Order", quantity: 1, unitAmount: 1200 }],
      },
      "sha256:x",
    );
    await s.payments.awaitCard(spend.spendRequestId);
    // The short card values are not substring-masked: a total like $1,737.00 stays readable.
    expect(s.redactor.redact("Total $1,737.00, ships 04/31")).toBe("Total $1,737.00, ships 04/31");
    const el = {
      tagName: "input",
      type: "text",
      autocomplete: "cc-number",
      frameOrigin: "https://evil.shop.example",
    };
    await expect(
      s.payments.cardSecret({
        spendRequestId: spend.spendRequestId,
        field: "number",
        origin: "https://evil.shop.example",
        element: el,
      }),
    ).rejects.toMatchObject({ details: { reason: "merchant_mismatch" } });
    await s.payments.cancel(spend.spendRequestId);
  });

  it("reads minor units", () => {
    expect(toMinor("12.5", "USD")).toBe(1250);
    expect(toMinor("1200", "JPY")).toBe(1200);
    expect(toMinor("1.234", "USD")).toBeUndefined();
  });
});
