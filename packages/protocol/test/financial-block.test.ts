import { describe, expect, it } from "vitest";
import {
  type FinancialAction,
  financialBlock,
  isTradeOrTransferText,
  venueOfApp,
  venueOfHost,
} from "../src/financial-block.ts";

/** Two lists, as for every classifier here: what must block, and near-misses that must not. */
const MUST_BLOCK: [string, FinancialAction][] = [
  // brokerage: an order ticket, buy and sell
  ["robinhood Buy", { pageUrl: "https://robinhood.com/stocks/AAPL", labels: ["Buy"] }],
  ["robinhood Place order", { pageUrl: "https://robinhood.com/", labels: ["Place order"] }],
  ["schwab Submit order", { origin: "https://client.schwab.com", labels: ["Submit order"] }],
  ["fidelity Sell", { origin: "https://digital.fidelity.com", labels: ["Sell"] }],
  [
    "ibkr Buy 10 shares",
    { origin: "https://www.interactivebrokers.com", labels: ["Buy 10 shares"] },
  ],
  [
    "brokerage Confirm on ticket",
    {
      pageUrl: "https://trade.webull.com/order-ticket/AAPL",
      labels: ["Confirm"],
      role: "button",
    },
  ],
  // exchange
  ["coinbase Buy", { origin: "https://www.coinbase.com", labels: ["Buy"] }],
  ["coinbase Send crypto", { origin: "https://www.coinbase.com", labels: ["Send"] }],
  ["kraken Withdraw", { origin: "https://pro.kraken.com", labels: ["Withdraw"] }],
  ["binance Convert", { origin: "https://www.binance.com", labels: ["Convert"] }],
  ["uniswap Swap", { origin: "https://app.uniswap.org", labels: ["Swap"] }],
  // bank
  ["chase Transfer money", { origin: "https://secure.chase.com", labels: ["Transfer money"] }],
  ["bofa Transfer", { origin: "https://www.bankofamerica.com", labels: ["Transfer"] }],
  [
    "bank Send with Zelle",
    { origin: "https://www.wellsfargo.com", labels: ["Send money with Zelle"] },
  ],
  ["bank Wire", { origin: "https://www.citi.com", labels: ["Wire transfer"] }],
  ["bank Withdraw", { origin: "https://www.capitalone.com", labels: ["Withdraw"] }],
  [
    "bank Confirm on transfer page",
    {
      pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfers/confirm",
      labels: ["Confirm"],
      role: "button",
    },
  ],
  [
    "bank submit POST to transfers",
    {
      origin: "https://www.ally.com",
      labels: ["Continue"],
      submits: true,
      formMethod: "post",
      formAction: "https://www.ally.com/api/transfers/submit",
    },
  ],
  ["real bank subdomain", { origin: "https://online.chase.com", labels: ["Transfer"] }],
  ["fintech Send", { origin: "https://wise.com", labels: ["Send"] }],
  // p2p
  ["venmo Pay", { origin: "https://venmo.com", labels: ["Pay"] }],
  ["cash app Send $50", { origin: "https://cash.app", labels: ["Send $50"] }],
  ["paypal Send money", { origin: "https://www.paypal.com", labels: ["Send Money"] }],
  ["western union Send", { origin: "https://www.westernunion.com", labels: ["Send"] }],
  // computer use: a native app by bundle id
  ["native broker app", { app: "com.robinhood.macos", labels: ["Buy"], role: "AXButton" }],
  ["native exchange app", { app: "com.coinbase.desktop", labels: ["Withdraw"] }],
  ["native bank app", { app: "com.chase.mobile", labels: ["Transfer"] }],
  ["native wallet app", { app: "io.metamask.desktop", labels: ["Send"] }],
  // a browser app showing a venue: the page decides
  [
    "chrome on a brokerage",
    { app: "com.google.Chrome", pageUrl: "https://www.schwab.com/trade", labels: ["Place order"] },
  ],
  // non-English labels
  ["es Transferir", { origin: "https://www.bbva.es", labels: ["Transferir"] }],
  ["fr Virement", { origin: "https://www.bnpparibas.com", labels: ["Effectuer un virement"] }],
  ["de Überweisung", { origin: "https://www.commerzbank.de", labels: ["Überweisung"] }],
  ["it Bonifico", { origin: "https://www.hsbc.com", labels: ["Bonifico"] }],
  ["pt Transferir", { origin: "https://nubank.com.br", labels: ["Transferir"] }],
  ["ja 送金", { origin: "https://www.smbc.co.jp", labels: ["送金する"] }],
  ["ja 注文", { origin: "https://www.etrade.com", labels: ["注文を確定"] }],
  ["zh 转账", { origin: "https://www.revolut.com", labels: ["转账"] }],
  ["ko 송금", { origin: "https://www.upbit.com", labels: ["송금"] }],
  ["ko 매수", { origin: "https://www.bithumb.com", labels: ["매수"] }],
  ["de Kaufen on exchange", { origin: "https://www.bitpanda.com", labels: ["Kaufen"] }],
  ["ar تحويل", { origin: "https://www.hsbc.com", labels: ["تحويل"] }],
  ["ru Перевод", { origin: "https://www.revolut.com", labels: ["Перевод"] }],
  // strong phrases anywhere
  [
    "unlisted site, buy stock",
    { origin: "https://app.unknown-broker.example", labels: ["Buy stock"] },
  ],
  ["unlisted site, market order", { origin: "https://x.example", labels: ["Submit market order"] }],
  [
    "unlisted site, transfer between accounts",
    { origin: "https://cu.example", labels: ["Transfer between accounts"] },
  ],
  ["unlisted site, send bitcoin", { origin: "https://w.example", labels: ["Send Bitcoin"] }],
  ["parent heading names it", { origin: "https://w.example", labels: ["OK", "Send money"] }],
];

const MUST_NOT_BLOCK: [string, FinancialAction][] = [
  // ordinary checkouts and bills
  [
    "buy shoes at a store",
    { origin: "https://shop.example.com", labels: ["Buy now"], role: "button" },
  ],
  ["place order at a store", { origin: "https://shop.example.com", labels: ["Place order"] }],
  ["pay at a merchant", { origin: "https://shop.example.com", labels: ["Pay $24.99"] }],
  [
    "checkout form post",
    {
      origin: "https://shop.example.com",
      labels: ["Continue"],
      submits: true,
      formMethod: "post",
      formAction: "https://shop.example.com/checkout/payment",
    },
  ],
  ["utility bill on the utility's site", { origin: "https://www.pge.com", labels: ["Pay bill"] }],
  ["utility Pay $120.50", { origin: "https://pay.coned.com", labels: ["Pay $120.50"] }],
  [
    "bank-transfer payment method at a merchant",
    { origin: "https://shop.example.de", labels: ["Per Überweisung bezahlen"] },
  ],
  [
    "wire transfer payment method",
    { origin: "https://shop.example.com", labels: ["Pay by wire transfer"] },
  ],
  ["Stripe Link checkout", { origin: "https://checkout.stripe.com", labels: ["Pay with Link"] }],
  ["Link on a merchant", { origin: "https://shop.example.com", labels: ["Pay with Link"] }],
  ["paypal checkout Pay Now", { origin: "https://www.paypal.com", labels: ["Pay Now"] }],
  ["paypal Complete Purchase", { origin: "https://www.paypal.com", labels: ["Complete Purchase"] }],
  ["paypal Continue", { origin: "https://www.paypal.com", labels: ["Continue"], role: "button" }],
  ["bank bill pay", { origin: "https://www.chase.com", labels: ["Pay bill"] }],
  // reading
  ["brokerage balance", { origin: "https://robinhood.com", labels: ["Account balance"] }],
  ["brokerage positions", { origin: "https://robinhood.com", labels: ["Portfolio"] }],
  ["bank transactions", { origin: "https://www.chase.com", labels: ["View transactions"] }],
  ["bank statements", { origin: "https://www.chase.com", labels: ["Statements"] }],
  ["transfer history", { origin: "https://www.chase.com", labels: ["Transfer history"] }],
  ["order history", { origin: "https://robinhood.com", labels: ["Order history"] }],
  ["order status", { origin: "https://www.schwab.com", labels: ["Order status"] }],
  ["quote", { origin: "https://www.coinbase.com", labels: ["Get a quote"] }],
  ["mobile check deposit", { origin: "https://www.chase.com", labels: ["Deposit a check"] }],
  ["bank Sign in", { origin: "https://www.chase.com", labels: ["Sign in"], role: "button" }],
  ["bank Continue", { origin: "https://www.chase.com", labels: ["Continue"], role: "button" }],
  [
    "bank Cancel in transfers section",
    { origin: "https://www.chase.com", labels: ["Cancel", "Transfers"] },
  ],
  ["bank Confirm elsewhere", { pageUrl: "https://www.chase.com/security", labels: ["Confirm"] }],
  // navigation never trades
  ["link Buy", { origin: "https://www.coinbase.com", labels: ["Buy"], role: "link" }],
  [
    "link Transfer money",
    { origin: "https://www.chase.com", labels: ["Transfer money"], role: "link" },
  ],
  ["AXLink Withdraw", { origin: "https://www.kraken.com", labels: ["Withdraw"], role: "AXLink" }],
  [
    "bank GET form",
    {
      origin: "https://www.chase.com",
      labels: ["Search"],
      submits: true,
      formMethod: "get",
      formAction: "https://www.chase.com/transfers/search",
    },
  ],
  // look-alike hosts are not the venue
  ["robinhood.com.evil.test", { origin: "https://robinhood.com.evil.test", labels: ["Buy"] }],
  [
    "evil host with robinhood in path",
    { origin: "https://evil.test/robinhood.com", labels: ["Sell"] },
  ],
  ["prefix glued on", { origin: "https://notrobinhood.com", labels: ["Buy"] }],
  ["userinfo trick", { origin: "https://robinhood.com@evil.test", labels: ["Buy"] }],
  ["bank lookalike", { origin: "https://chase.com.evil.test", labels: ["Transfer"] }],
  ["bank homoglyph", { origin: "https://chаse.com", labels: ["Transfer"] }],
  [
    "gemini.google.com is not gemini.com",
    { origin: "https://gemini.google.com", labels: ["Send"] },
  ],
  // ordinary words that share a verb
  ["send message", { origin: "https://mail.example.com", labels: ["Send message"] }],
  ["transfer a file", { origin: "https://files.example.com", labels: ["Transfer file"] }],
  ["wire up", { origin: "https://dev.example.com", labels: ["Wire up the hooks"] }],
  ["send feedback", { origin: "https://app.example.com", labels: ["Send feedback"] }],
  ["buy tickets", { origin: "https://tickets.example.com", labels: ["Buy tickets"] }],
  ["trade cards", { origin: "https://cards.example.com", labels: ["Trade cards"] }],
  ["sell your car", { origin: "https://cars.example.com", labels: ["Sell your car"] }],
  ["shares of a document", { origin: "https://docs.example.com", labels: ["Shares"] }],
  ["native shop app", { app: "com.apple.AppStore", labels: ["Buy"] }],
  ["native mail app Send", { app: "com.apple.mail", labels: ["Send"] }],
  ["native banking-looking but not listed", { app: "com.example.budget", labels: ["Transfer"] }],
  ["empty", {}],
];

describe("financialBlock: must block", () => {
  it.each(MUST_BLOCK)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeDefined();
  });
});

describe("financialBlock: must not block", () => {
  it.each(MUST_NOT_BLOCK)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeUndefined();
  });
});

describe("venues", () => {
  it("matches a registered domain and its real subdomains only", () => {
    expect(venueOfHost("https://robinhood.com")).toBe("brokerage");
    expect(venueOfHost("https://www.robinhood.com/x")).toBe("brokerage");
    expect(venueOfHost("secure.chase.com")).toBe("bank");
    expect(venueOfHost("https://ROBINHOOD.COM.")).toBe("brokerage");
    expect(venueOfHost("https://robinhood.com.evil.test")).toBeUndefined();
    expect(venueOfHost("https://evilrobinhood.com")).toBeUndefined();
    expect(venueOfHost("not a url")).toBeUndefined();
    expect(venueOfHost(undefined)).toBeUndefined();
  });

  it("matches app bundle ids on a dotted boundary", () => {
    expect(venueOfApp("com.robinhood.macos")).toBe("brokerage");
    expect(venueOfApp("com.robinhood")).toBe("brokerage");
    expect(venueOfApp("com.robinhoodie.app")).toBeUndefined();
    expect(venueOfApp("com.apple.mail")).toBeUndefined();
  });
});

describe("isTradeOrTransferText", () => {
  it("reads tool-name casing", () => {
    expect(isTradeOrTransferText("executeTrade", "brokerage")).toBe(true);
    expect(isTradeOrTransferText("buy_stock")).toBe(true);
    expect(isTradeOrTransferText("sellShares")).toBe(true);
  });
});
