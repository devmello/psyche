import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog, hashCanonical } from "@psyche/audit";
import { parseMoney, readOrder } from "@psyche/browser";
import { createPermissionBroker } from "@psyche/permissions";
import { PsycheError } from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { FakeClock, FakeNotifier } from "@psyche/testing";
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
    /** The pay button's name in the snapshot text and refs (default "Pay now"); `n` is the snapshot. */
    button?: (n: number) => string;
    /** The page's address in snapshot `n` (default: the origin). */
    url?: (n: number) => string;
    /** Whether Stripe Link is connected and signed in (absent: always). */
    ready?: () => boolean;
    /** The tab's live address (default: the snapshot's, else the origin); undefined: unreadable. */
    liveUrl?: (n: number) => string | undefined;
    /** No snapshot read since the page loaded. */
    noPeek?: boolean;
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
    tabUrl: () =>
      opts.liveUrl !== undefined
        ? opts.liveUrl(snaps)
        : opts.url === undefined
          ? (opts.origin ?? (() => ORIGIN))()
          : opts.url(snaps),
    peekSnapshot: () =>
      opts.noPeek === true
        ? undefined
        : {
            text: `${page()}\n- button "${(opts.button ?? (() => "Pay now"))(0)}" [ref=r4]`,
            url: opts.url === undefined ? (opts.origin ?? (() => ORIGIN))() : opts.url(0),
          },
    snapshot: async () => {
      const n = nextSnap();
      return {
        url: opts.url === undefined ? (opts.origin ?? (() => ORIGIN))() : opts.url(n),
        text: opts.snapshotText === undefined ? page() : opts.snapshotText(n),
        refs: [
          { ref: "r1", role: "textbox", name: "Card number" },
          { ref: "r2", role: "textbox", name: "Expiry" },
          { ref: "r3", role: "textbox", name: "CVC" },
          { ref: "r4", role: "button", name: (opts.button ?? (() => "Pay now"))(n) },
        ],
      };
    },
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
    ...(opts.ready === undefined ? {} : { ready: opts.ready }),
  });
  const params = { tabId: "t1" };
  const approve = (total = "$12.00", id = "ap1", at = (opts.origin ?? (() => ORIGIN))()) =>
    approvals.set(id, {
      bindingHash: toolCallBindingHash(PURCHASE_TOOL, params, {
        kind: "purchase",
        bindingFields: purchaseFields(readOrder(PAGE(total), at)),
      }),
      scopeGranted: "once",
      status: "approved",
      kind: "purchase",
      requestedBy: { taskId: "task1" },
    });
  return {
    clicked: () => clicked,
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

/**
 * #1321 round 6: the Link purchase tool is under the hard block on trades and transfers. On a
 * brokerage, an exchange, a P2P service or a bank it is refused before any card is shown; at a
 * merchant (PayPal's checkout included) it still asks on the Pay card.
 */
/**
 * #1323 N6 and N7: a reference to the tool held from before a disconnect (the loop builds its tool
 * list once per step) raises no Pay card and pays nothing while Link is not connected and signed in.
 */
describe("checkout.pay_with_link while Stripe Link is not ready", () => {
  it("describes no Pay card and pays nothing, even with an approval in hand", async () => {
    let ready = true;
    const s = setup({ ready: () => ready });
    expect(s.tool.describeCall?.(s.params)).toMatchObject({ kind: "purchase" });
    ready = false;
    expect(() => s.tool.describeCall?.(s.params)).toThrow(/not connected and signed in/);
    s.approve();
    await expect(run(s)).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "payments_not_ready" },
    });
    expect(s.wallet.created).toBe(0);
    expect(s.clicked()).toBe(false);
    // Ready again: the same reference pays.
    ready = true;
    await expect(run(s)).resolves.toMatchObject({ output: { status: "paid" } });
  });
});

describe("checkout.pay_with_link and the hard block on trades and transfers", () => {
  const decide = async (
    origin: string,
    button: string,
    url?: string,
    extra: Parameters<typeof setup>[0] = {},
  ) => {
    const s = setup({
      origin: () => origin,
      button: () => button,
      page: () => PAGE("$12.00"),
      ...(url === undefined ? {} : { url: () => url }),
      ...extra,
    });
    const d = s.tool.describeCall?.(s.params);
    const clock = new FakeClock();
    const broker = createPermissionBroker({
      approvers: {
        device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      },
      clock,
      audit: createAuditLog({ clock }),
      notifier: new FakeNotifier({ clock }),
    });
    return broker.decide(
      {
        tool: PURCHASE_TOOL,
        sideEffect: "financial",
        targetKind: "origin",
        ...(d?.target === undefined ? {} : { target: d.target }),
        params: s.params,
        paramsHash: hashCanonical(s.params),
        kind: "purchase",
        ...(d?.meta === undefined ? {} : { meta: d.meta }),
      } as never,
      {
        threadId: "thr1",
        runId: "run1",
        taskId: "task1",
        permissionMode: "auto",
        taint: false,
      } as never,
    );
  };

  it.each([
    ["https://www.coinbase.com", "Buy now"],
    ["https://venmo.com", "Pay"],
    ["https://secure.chase.com", "Pay now"],
    ["https://robinhood.com", "Buy now"],
    // follow-ups to #1321: crypto on-ramps
    ["https://buy.moonpay.com", "Buy now"],
    ["https://app.ramp.network", "Buy now"],
    ["https://global.transak.com", "Buy now"],
    ["https://pay.coinbase.com", "Pay now"],
    ["https://crypto.link.com", "Buy now"],
    ["https://widget.wert.io", "Pay"],
    ["https://checkout.bitpay.com", "Pay"],
  ])("on %s (%s) it is refused before any card", async (origin, button) => {
    const d = await decide(origin, button);
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
  });

  it.each([
    "https://www.paypal.com/paypalme/john",
    "https://www.paypal.com/paypalme/john/50",
    "https://www.paypal.com/myaccount/transfer/homepage/pay",
    "https://www.paypal.com/us/myaccount/transfer/send",
  ])("on PayPal's person-to-person page %s it is refused before any card", async (url) => {
    const d = await decide("https://www.paypal.com", "Pay", url);
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
  });

  it.each([
    ["https://shop.example.com", "Pay now"],
    ["https://www.paypal.com", "Pay Now"],
    ["https://www.amazon.com", "Place your order"],
    ["https://ultimaterewardspoints.chase.com", "Pay now"],
    ["https://www.paypal.com/checkoutnow?token=EC-1", "Pay Now"],
    ["https://www.paypal.com/webapps/hermes?token=EC-1", "Complete Purchase"],
  ])("at the merchant %s (%s) it still asks on the Pay card", async (at, button) => {
    const u = new URL(at);
    const d = await decide(u.origin, button, at);
    expect(d.decision).toBe("ask");
    expect(d.rule).not.toBe("prohibition:financial_transfer");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it("judges the tab's live address, not the last snapshot (#1332 N1)", async () => {
    const P = "https://www.paypal.com";
    // No snapshot since the page loaded: the live address is a PayPal.Me page.
    expect(
      await decide(P, "Pay", undefined, { noPeek: true, liveUrl: () => `${P}/paypalme/john/12` }),
    ).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
    // A stale snapshot of the checkout, after a route change to PayPal.Me.
    expect(
      await decide(P, "Pay", `${P}/checkoutnow`, { liveUrl: () => `${P}/paypalme/john/12` }),
    ).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
    // No readable live address on PayPal: unreadable, refused.
    expect(
      await decide(P, "Pay Now", `${P}/checkoutnow`, { liveUrl: () => undefined }),
    ).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
    // A shop with no readable live address is not a venue: the Pay card still asks.
    expect(
      (await decide("https://shop.example.com", "Pay now", undefined, { liveUrl: () => undefined }))
        .decision,
    ).toBe("ask");
    // The checkout itself, live and in the snapshot, still asks.
    expect(
      (await decide(P, "Pay Now", `${P}/checkoutnow`, { liveUrl: () => `${P}/checkoutnow` }))
        .decision,
    ).toBe("ask");
  });

  it("refuses at run time on PayPal with no readable live address, before any spend", async () => {
    const s = setup({
      origin: () => "https://www.paypal.com",
      url: () => "https://www.paypal.com/checkoutnow",
      liveUrl: () => undefined,
    });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({
      code: "policy_denied",
      details: { rule: "prohibition:financial_transfer" },
    });
    expect(s.wallet.created).toBe(0);
    expect(s.clicked()).toBe(false);
  });

  it("refuses before the click when the live address moved to PayPal.Me, the snapshot stale", async () => {
    // Every snapshot still shows the checkout; only the live address shows the route change.
    const s = setup({
      origin: () => "https://www.paypal.com",
      url: () => "https://www.paypal.com/checkoutnow",
      liveUrl: (n) =>
        n >= 3 ? "https://www.paypal.com/paypalme/john/12" : "https://www.paypal.com/checkoutnow",
    });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({
      code: "policy_denied",
      details: { rule: "prohibition:financial_transfer" },
    });
    expect(s.clicked()).toBe(false);
    expect(s.wallet.cancelled).toBeGreaterThan(0);
  });

  it("refuses before the click when the tab moved to a PayPal.Me page, and cancels in Link", async () => {
    // Same origin throughout: only the page's path says it is now a send to a person.
    const s = setup({
      origin: () => "https://www.paypal.com",
      url: (n) =>
        n >= 3 ? "https://www.paypal.com/paypalme/john/12" : "https://www.paypal.com/checkoutnow",
    });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({
      code: "policy_denied",
      details: { rule: "prohibition:financial_transfer" },
    });
    expect(s.clicked()).toBe(false);
    expect(s.wallet.cancelled).toBeGreaterThan(0);
  });

  it("refuses at run time on a venue tab, before any spend request", async () => {
    const s = setup({ origin: () => "https://www.coinbase.com", button: () => "Buy now" });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({
      code: "policy_denied",
      details: { rule: "prohibition:financial_transfer" },
    });
    expect(s.wallet.created).toBe(0);
    expect(s.clicked()).toBe(false);
  });

  it("refuses before the click when the pay button turned into a trade, and cancels in Link", async () => {
    // The first snapshots show "Pay now"; the last look before the click shows a crypto buy.
    const s = setup({ button: (n) => (n >= 3 ? "Buy now 1 BTC" : "Pay now") });
    s.approve();
    await expect(run(s)).rejects.toMatchObject({
      code: "policy_denied",
      details: { rule: "prohibition:financial_transfer" },
    });
    expect(s.clicked()).toBe(false);
    expect(s.wallet.cancelled).toBeGreaterThan(0);
  });
});
