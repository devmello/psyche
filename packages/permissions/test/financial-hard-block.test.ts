import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker, origin } from "./helpers.ts";

/**
 * The hard block on trades, bank-to-bank transfers, P2P sends and crypto sends
 * (`prohibition:financial_transfer`): terminal on every path, whatever the policy and whatever the
 * owner approved. Two lists, as for every classifier here: what must be refused, and the
 * near-misses (checkouts, bills, reading, look-alike hosts) that must still reach the Pay card.
 */

const app = (value: string) => ({ kind: "app" as const, value });

interface Row {
  name: string;
  tool: string;
  sideEffect?: "financial" | "write" | "read";
  target?: ReturnType<typeof origin> | ReturnType<typeof app>;
  meta?: Record<string, unknown>;
}

const browser = (
  host: string,
  label: string,
  more: Record<string, unknown> = {},
  tool = "browser.click",
): Row => ({
  name: `${host}: ${label}`,
  tool,
  sideEffect: "financial",
  target: origin(`https://${host}`),
  meta: { action: "click", control: { labels: [label], role: "button", ...more } },
});

const computer = (bundle: string, label: string, more: Record<string, unknown> = {}): Row => ({
  name: `${bundle}: ${label}`,
  tool: "computer.act",
  sideEffect: "financial",
  target: app(bundle),
  meta: { app: bundle, action: "click", control: { labels: [label], ...more } },
});

const MUST_BLOCK: Row[] = [
  // tools
  { name: "tool bank.transfer", tool: "bank.transfer", sideEffect: "financial" },
  { name: "tool broker.trade", tool: "broker.trade", sideEffect: "financial" },
  { name: "tool buy_stock", tool: "trading.buy_stock", sideEffect: "financial" },
  { name: "tool sellShares", tool: "sellShares", sideEffect: "financial" },
  { name: "tool place_stock_order", tool: "acme.place_stock_order", sideEffect: "financial" },
  { name: "tool send_bitcoin", tool: "wallet_tools.send_bitcoin", sideEffect: "financial" },
  { name: "tool swap tokens", tool: "defi.swap_tokens", sideEffect: "financial" },
  // MCP
  { name: "mcp alpaca submitOrder", tool: "mcp__alpaca__submitOrder", sideEffect: "write" },
  {
    name: "mcp interactive-brokers",
    tool: "mcp__interactive-brokers__place_order",
    sideEffect: "write",
  },
  { name: "mcp coinbase", tool: "mcp__coinbase__createTrade", sideEffect: "write" },
  { name: "mcp zelle", tool: "mcp__zelle__send-payment", sideEffect: "write" },
  { name: "mcp wire", tool: "mcp__bank__wire-transfer", sideEffect: "write" },
  { name: "mcp unlisted: buy_shares", tool: "mcp__acme__buy_shares", sideEffect: "write" },
  { name: "mcp unlisted: send money", tool: "mcp__acme__send_money", sideEffect: "write" },
  { name: "mcp cash app", tool: "mcp__cash_app__pay", sideEffect: "write" },
  // browser
  browser("robinhood.com", "Buy"),
  browser("www.robinhood.com", "Place order"),
  browser("client.schwab.com", "Submit order"),
  browser("www.coinbase.com", "Send"),
  browser("secure.chase.com", "Transfer money"),
  browser("www.bankofamerica.com", "Transfer"),
  browser("venmo.com", "Pay"),
  browser("www.paypal.com", "Send Money"),
  browser("www.ally.com", "Continue", {
    submits: true,
    formMethod: "post",
    formAction: "https://www.ally.com/api/transfers/submit",
  }),
  browser("secure.chase.com", "Confirm", {
    pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfers/confirm",
  }),
  browser("www.smbc.co.jp", "送金する"),
  browser("www.commerzbank.de", "Überweisung"),
  browser("www.bbva.es", "Transferir"),
  browser("www.upbit.com", "매수"),
  browser("app.unlisted-broker.example", "Buy stock"),
  browser("www.kraken.com", "", { unreadable: true }, "browser.click"),
  browser("www.coinbase.com", "", { unreadable: true }, "browser.press"),
  // computer use
  computer("com.robinhood.macos", "Buy"),
  computer("com.coinbase.desktop", "Withdraw"),
  computer("com.chase.mobile", "Transfer"),
  computer("io.metamask.desktop", "Send"),
  computer("com.google.Chrome", "Place order", { pageUrl: "https://www.schwab.com/trade" }),
  computer("com.google.Chrome", "Transfer", {
    pageUrl: "https://www.wellsfargo.com/",
    role: "AXButton",
  }),
  computer("com.apple.Safari", "Sell", { pageUrl: "https://digital.fidelity.com/" }),
  computer("com.robinhood.macos", "", { unreadable: true }),
  computer("com.google.Chrome", "Buy bitcoin"),
];

const MUST_NOT_BLOCK: Row[] = [
  { name: "tool calendar.create", tool: "calendar.create", sideEffect: "write" },
  { name: "tool Link purchase", tool: "link.purchase", sideEffect: "financial" },
  { name: "tool payments.link_spend", tool: "payments.link_spend", sideEffect: "financial" },
  { name: "tool shop.place_order", tool: "shop.place_order", sideEffect: "financial" },
  { name: "mcp restaurant place_order", tool: "mcp__tacos__place_order", sideEffect: "write" },
  { name: "mcp github create_issue", tool: "mcp__github__create_issue", sideEffect: "write" },
  { name: "mcp exchange mail", tool: "mcp__outlook__send_mail", sideEffect: "write" },
  { name: "mcp portfolio read", tool: "mcp__robinhood_notes__list_notes", sideEffect: "read" },
  // checkouts and bills
  browser("shop.example.com", "Buy now"),
  browser("shop.example.com", "Place order"),
  browser("shop.example.com", "Pay $24.99"),
  browser("checkout.stripe.com", "Pay with Link"),
  browser("www.pge.com", "Pay bill"),
  browser("pay.coned.com", "Pay $120.50"),
  browser("www.paypal.com", "Pay Now"),
  browser("www.paypal.com", "Complete Purchase"),
  browser("shop.example.com", "Continue", {
    submits: true,
    formMethod: "post",
    formAction: "https://shop.example.com/checkout/payment",
  }),
  browser("www.chase.com", "Pay bill"),
  // reading
  browser("robinhood.com", "Account balance"),
  browser("www.chase.com", "View transactions"),
  browser("www.chase.com", "Transfer history"),
  browser("robinhood.com", "Order history"),
  // navigation
  browser("www.coinbase.com", "Buy", { role: "link" }),
  browser("www.chase.com", "Transfer money", { role: "link" }),
  // look-alike hosts
  browser("robinhood.com.evil.test", "Buy"),
  browser("notrobinhood.com", "Buy"),
  browser("chase.com.evil.test", "Transfer"),
  browser("gemini.google.com", "Send"),
  // ordinary words
  browser("mail.example.com", "Send message"),
  browser("files.example.com", "Transfer file"),
  computer("com.apple.mail", "Send"),
  computer("com.apple.AppStore", "Buy"),
  computer("com.google.Chrome", "Place order", { pageUrl: "https://shop.example.com/cart" }),
  computer("com.google.Chrome", "Pay", { pageUrl: "https://shop.example.com/checkout" }),
  computer("com.robinhood.macos", "Account balance"),
  computer("com.apple.mail", "", { unreadable: true }),
];

const policies = [
  { name: "default policy", opts: {} },
  { name: "allow-all policy", opts: { policy: { allow: ["*"] } } },
];

describe("financial hard block: refused on every path", () => {
  for (const p of policies) {
    for (const mode of ["manual", "balanced", "auto"] as const) {
      it.each(MUST_BLOCK.map((r) => [r.name, r] as const))(
        `${p.name}, ${mode}: %s`,
        async (_name, r) => {
          const h = makeBroker(p.opts);
          const c = call(r.tool, r.sideEffect ?? "write", r.target, {
            meta: r.meta,
          } as never);
          const d = await h.broker.decide(c, { ...CTX, permissionMode: mode });
          expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
          expect(d.reason).toMatch(/yourself/);
        },
      );
    }
  }
});

describe("financial hard block: ordinary actions keep their own rule", () => {
  it.each(MUST_NOT_BLOCK.map((r) => [r.name, r] as const))("%s", async (_name, r) => {
    const h = makeBroker({ policy: { allow: ["*"] } });
    const c = call(r.tool, r.sideEffect ?? "write", r.target, { meta: r.meta } as never);
    const d = await h.broker.decide(c, { ...CTX, permissionMode: "balanced" });
    expect(d.rule, r.name).not.toBe("prohibition:financial_transfer");
  });

  it("a checkout still reaches the Pay card (financial, ask)", async () => {
    const h = makeBroker();
    const r = browser("shop.example.com", "Place order");
    const c = call(r.tool, "financial", r.target, { meta: r.meta, kind: "purchase" } as never);
    const d = await h.broker.decide(c, { ...CTX, permissionMode: "auto" });
    expect(d.decision).toBe("ask");
    expect(d.scopesOffered).toEqual(["once"]);
  });
});

describe("financial hard block: no approval or standing grant unlocks it", () => {
  it("an approval for the same call is not honoured: the next decide still denies", async () => {
    const h = makeBroker();
    const r = browser("shop.example.com", "Place order");
    // The owner approves a checkout on the shop…
    const shop = call(r.tool, "financial", r.target, { meta: r.meta, kind: "purchase" } as never);
    const first = await h.broker.decide(shop, { ...CTX, permissionMode: "auto" });
    expect(first.decision).toBe("ask");
    // …and the same control label on a brokerage is still refused outright.
    const t = browser("robinhood.com", "Place order");
    const trade = call(t.tool, "financial", t.target, { meta: t.meta, kind: "purchase" } as never);
    const d = await h.broker.decide(trade, { ...CTX, permissionMode: "auto" });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
    expect(d.scopesOffered ?? []).toEqual([]);
  });

  it("a control the executor could not read on a venue is refused, not asked", async () => {
    const h = makeBroker();
    const t = browser("www.chase.com", "", { unreadable: true });
    const d = await h.broker.decide(
      call(t.tool, "write", t.target, { meta: t.meta } as never),
      CTX,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
  });
});
