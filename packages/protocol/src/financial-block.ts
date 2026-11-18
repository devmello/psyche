/**
 * The hard block on trading and moving money (`prohibition:financial_transfer`), as one pure rule
 * for every path that can act on a page or an app: the browser, computer use and the broker's own
 * check. Browser-safe: no Node imports (`@psyche/protocol/financial-block`).
 *
 * Psyche never trades securities or crypto, moves money between bank accounts, sends money to a
 * person, or withdraws from an exchange, even if the owner approves. The block is deterministic:
 * it never asks a model. Two things decide it:
 *
 * - the venue: a brokerage, exchange, bank or peer-to-peer service, by the host of the page (a
 *   registered domain or a real subdomain of it, never `robinhood.com.evil.test`) or by the app's
 *   bundle id;
 * - the action: a control, form or window that trades or moves money, in the words of the ten
 *   languages the app ships in.
 *
 * A card checkout at a merchant, a utility bill paid on the utility's own site and a Stripe Link
 * purchase are payments, not this: they stay a `financial` Pay card. Reading a balance or a list
 * of transactions moves nothing. A link that only navigates is never blocked.
 */

import { moneyWords } from "./money-intent.ts";

export type VenueKind = "brokerage" | "exchange" | "bank" | "p2p" | "p2p_mixed";

/** Registered domains. A host matches the domain itself or any subdomain of it. */
const HOST_VENUES: Record<VenueKind, readonly string[]> = {
  brokerage: [
    "robinhood.com",
    "schwab.com",
    "fidelity.com",
    "etrade.com",
    "tdameritrade.com",
    "interactivebrokers.com",
    "ibkr.com",
    "vanguard.com",
    "webull.com",
    "public.com",
    "tastytrade.com",
    "tradestation.com",
    "firstrade.com",
    "merrilledge.com",
    "wealthfront.com",
    "betterment.com",
    "acorns.com",
    "m1.com",
    "alpaca.markets",
    "tradier.com",
    "trading212.com",
    "degiro.com",
    "etoro.com",
    "saxo.com",
    "freetrade.io",
    "moomoo.com",
    "zerodha.com",
  ],
  exchange: [
    "coinbase.com",
    "binance.com",
    "binance.us",
    "kraken.com",
    "gemini.com",
    "bitstamp.net",
    "crypto.com",
    "okx.com",
    "bybit.com",
    "kucoin.com",
    "bitfinex.com",
    "uphold.com",
    "bitget.com",
    "gate.io",
    "htx.com",
    "mexc.com",
    "bitpanda.com",
    "bitso.com",
    "upbit.com",
    "bithumb.com",
    "bitflyer.com",
    "uniswap.org",
    "1inch.io",
    "jup.ag",
    "pancakeswap.finance",
    "phantom.app",
    "metamask.io",
    "dydx.exchange",
    "hyperliquid.xyz",
  ],
  bank: [
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    "citibank.com",
    "capitalone.com",
    "usbank.com",
    "pnc.com",
    "tdbank.com",
    "td.com",
    "truist.com",
    "ally.com",
    "discover.com",
    "hsbc.com",
    "hsbc.co.uk",
    "barclays.co.uk",
    "barclays.com",
    "lloydsbank.com",
    "natwest.com",
    "santander.com",
    "santander.co.uk",
    "bmo.com",
    "rbc.com",
    "royalbank.com",
    "scotiabank.com",
    "cibc.com",
    "ing.com",
    "ing.de",
    "ing.nl",
    "db.com",
    "deutsche-bank.de",
    "commerzbank.de",
    "bnpparibas.com",
    "sparkasse.de",
    "bbva.com",
    "bbva.es",
    "caixabank.es",
    "sofi.com",
    "chime.com",
    "marcus.com",
    "usaa.com",
    "navyfederal.org",
    "citizensbank.com",
    "regions.com",
    "key.com",
    "huntington.com",
    "fifththird.com",
    "53.com",
    "mtb.com",
    "wise.com",
    "revolut.com",
    "monzo.com",
    "n26.com",
    "starlingbank.com",
    "nubank.com.br",
    "varomoney.com",
    "mercury.com",
    "commbank.com.au",
    "anz.com",
    "westpac.com.au",
    "nab.com.au",
    "smbc.co.jp",
    "mufg.jp",
    "mizuhobank.co.jp",
    "rakuten-bank.co.jp",
    "hdfcbank.com",
    "icicibank.com",
    "sbi.co.in",
    "axisbank.com",
  ],
  // Pure peer-to-peer: even a bare "Pay" is a payment to a person.
  p2p: [
    "venmo.com",
    "cash.app",
    "zellepay.com",
    "paypal.me",
    "remitly.com",
    "westernunion.com",
    "moneygram.com",
    "xoom.com",
    "worldremit.com",
  ],
  // Also a merchant checkout: "Pay" is a purchase there, only sending to a person is blocked.
  p2p_mixed: ["paypal.com", "payoneer.com"],
};

/** Bundle ids (and their dotted prefixes) of brokerage, exchange, bank, wallet and P2P apps. */
const APP_VENUES: Record<VenueKind, readonly string[]> = {
  brokerage: [
    "com.robinhood",
    "com.schwab",
    "com.fidelity",
    "com.etrade",
    "com.interactivebrokers",
    "com.ibkr",
    "com.webull",
    "com.vanguard",
    "com.tastytrade",
    "com.tradestation",
  ],
  exchange: [
    "com.coinbase",
    "com.binance",
    "com.kraken",
    "com.gemini",
    "com.ledger",
    "io.metamask",
    "app.phantom",
    "com.exodus",
    "org.electrum",
    "com.crypto",
  ],
  bank: [
    "com.chase",
    "com.bankofamerica",
    "com.wellsfargo",
    "com.citi",
    "com.capitalone",
    "com.usbank",
    "com.ally",
    "com.wise",
    "com.revolut",
    "com.sofi",
    "com.usaa",
  ],
  p2p: ["com.venmo", "com.squareup.cash", "com.zellepay", "com.westernunion", "com.remitly"],
  p2p_mixed: ["com.paypal"],
};

/** `host` is `domain` or a subdomain of it, on a label boundary. */
function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The lowercase hostname of a URL, an origin or a bare host; undefined when there is none. */
export function financialHost(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const text = input.trim();
  if (text === "") return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  return host === "" ? undefined : host;
}

export function venueOfHost(input: string | undefined): VenueKind | undefined {
  const host = financialHost(input);
  if (host === undefined) return undefined;
  for (const kind of Object.keys(HOST_VENUES) as VenueKind[]) {
    if (hostIn(host, HOST_VENUES[kind])) return kind;
  }
  return undefined;
}

export function venueOfApp(bundleId: string | undefined): VenueKind | undefined {
  if (bundleId === undefined) return undefined;
  const id = bundleId.trim().toLowerCase();
  for (const kind of Object.keys(APP_VENUES) as VenueKind[]) {
    if (APP_VENUES[kind].some((p) => id === p || id.startsWith(`${p}.`))) return kind;
  }
  return undefined;
}

// ---- the action -------------------------------------------------------------------------------

const SECURITY_OBJECT =
  "(stocks?|shares?|etfs?|equit(?:y|ies)|bonds?|futures|forex|securit(?:y|ies)|crypto(?:currency|currencies)?|bitcoins?|btc|ethereum|eth|dogecoin|doge|xrp|usdc|usdt)";

/** Phrases that trade or move money wherever they appear: no merchant checkout is labelled so. */
const UNIVERSAL: readonly RegExp[] = [
  new RegExp(`\\b(buy|sell|short|trade|trading)\\s+(?:\\w+\\s+){0,2}${SECURITY_OBJECT}\\b`),
  /\b(?:limit|market|stop|stop limit|stop loss|buy|sell)\s+order\b/,
  /\border ticket\b/,
  /\b(?:place|submit|execute|confirm|review|preview)\s+(?:a |the |your |my )?(?:trade|stock order|crypto order|options? order)\b/,
  /\bswap\s+(?:\w+\s+){0,2}(?:tokens?|crypto|coins?)\b/,
  /\btransfer\s+(?:money|funds|cash)\b/,
  /\btransfer\s+(?:\w+\s+){0,2}between\s+(?:\w+\s+){0,2}accounts?\b/,
  /\btransfer\s+to\s+(?:my |another |a |an )?(?:bank|checking|savings|brokerage|external|linked)\b/,
  /\bmove\s+(?:money|funds|cash)\b/,
  /\bwire\s+(?:money|funds)\b/,
  /\bsend\s+(?:money|funds|cash)\b/,
  new RegExp(`\\b(?:send|withdraw|transfer)\\s+(?:\\w+\\s+){0,2}${SECURITY_OBJECT}\\b`),
  /\bwithdraw\s+(?:funds|money|cash|crypto)\b/,
  /\bzelle\b/,
];

/** On a venue the verbs themselves are enough ("Buy", "Withdraw", "Transfer", "Send $50"). */
const VENUE_TRADE_WORDS = new Set([
  "buy",
  "sell",
  "short",
  "cover",
  "trade",
  "swap",
  "convert",
  "stake",
  "unstake",
  "order",
  // es / pt / fr / de / it / ru / ar / hi
  "comprar",
  "vender",
  "acheter",
  "vendre",
  "kaufen",
  "verkaufen",
  "kauf",
  "verkauf",
  "compra",
  "acquista",
  "acquistare",
  "comprare",
  "vendi",
  "vendere",
  "купить",
  "продать",
  "شراء",
  "بيع",
  "खरीदें",
  "बेचें",
]);
const VENUE_MOVE_WORDS = new Set([
  "transfer",
  "transfers",
  "wire",
  "withdraw",
  "withdrawal",
  "send",
  "remit",
  "zelle",
  "deposit",
  "payout",
  // es / pt / fr / de / it / ru / ar / hi
  "transferir",
  "transferencia",
  "transferência",
  "enviar",
  "retirar",
  "retiro",
  "sacar",
  "saque",
  "transférer",
  "transfert",
  "virement",
  "virer",
  "envoyer",
  "retrait",
  "überweisen",
  "überweisung",
  "ueberweisung",
  "senden",
  "auszahlen",
  "auszahlung",
  "bonifico",
  "trasferire",
  "trasferimento",
  "invia",
  "inviare",
  "prelievo",
  "prelevare",
  "перевод",
  "перевести",
  "вывод",
  "вывести",
  "تحويل",
  "سحب",
  "إرسال",
  "ट्रांसफर",
  "निकासी",
]);
/** CJK has no spaces between words: these are matched as substrings. */
const VENUE_CJK = [
  "振込",
  "振り込み",
  "送金",
  "出金",
  "引き出し",
  "買い",
  "売り",
  "買う",
  "売る",
  "売却",
  "注文",
  "成行",
  "指値",
  "转账",
  "轉帳",
  "转帐",
  "汇款",
  "匯款",
  "提现",
  "提現",
  "转出",
  "轉出",
  "买入",
  "買入",
  "卖出",
  "賣出",
  "下单",
  "下單",
  "이체",
  "송금",
  "출금",
  "매수",
  "매도",
  "주문",
];
/** A word that follows "send"/"transfer"/"order" and makes it not a transfer or order itself. */
const NOT_THE_ACTION = new Set([
  "history",
  "status",
  "details",
  "detail",
  "list",
  "limits",
  "limit",
  "fees",
  "fee",
  "receipt",
  "receipts",
  "reminder",
  "reminders",
  "statement",
  "statements",
  "confirmation",
  "feedback",
  "message",
  "messages",
  "email",
  "invoice",
  "request",
  "requests",
  "help",
  "faq",
  "info",
  "information",
  "tracking",
  "again",
  "book",
  "form",
  "forms",
  "pdf",
  "report",
  "reports",
]);

/**
 * Whether one label, name or sentence is a trade or a transfer of money on a venue of `kind`, or
 * (with no venue) one of the phrases that are never anything else.
 */
export function isTradeOrTransferText(text: string | undefined, kind?: VenueKind): boolean {
  if (text === undefined || text.trim() === "") return false;
  const norm = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  // Words are split the way tool names are, so `executeTrade` and `place_order` read as phrases.
  const spaced = moneyWords(text.normalize("NFKC")).join(" ");
  if (UNIVERSAL.some((re) => re.test(norm) || re.test(spaced))) return true;
  if (kind === undefined) return false;
  if (VENUE_CJK.some((w) => norm.includes(w))) return true;
  const words = moneyWords(text.normalize("NFKC"));
  if (words.length === 0) return false;
  // Quotes, previews and lists move nothing.
  const first = words[0] ?? "";
  if (
    ["get", "list", "view", "show", "see", "read", "check", "history", "quote", "preview"].includes(
      first,
    )
  )
    return false;
  const tradeVenue = kind === "brokerage" || kind === "exchange";
  for (const [i, w] of words.entries()) {
    const next = words[i + 1];
    const notAction = next !== undefined && NOT_THE_ACTION.has(next);
    if (tradeVenue && VENUE_TRADE_WORDS.has(w) && !notAction) {
      // "Order history" and "order status" read; "Order" or "place order" trades.
      if (w === "order" && words.length > 3) continue;
      return true;
    }
    if (VENUE_MOVE_WORDS.has(w) && !notAction) {
      // A word alone is enough on a venue, but "deposit" and "send" in a long sentence are not.
      if (
        (w === "deposit" || w === "send" || w === "enviar" || w === "envoyer") &&
        words.length > 4
      )
        continue;
      // Banks and brokerages take deposits (a check, a paycheck): not a transfer out.
      if (w === "deposit" && kind === "bank") continue;
      return true;
    }
  }
  // "Pay $20" or "Pay Sam" on Venmo or Cash App pays a person. On PayPal it can be a checkout, and
  // at a bank it is bill pay: both stay a payment.
  return kind === "p2p" && words[0] === "pay";
}

/** A form that posts to a transfer, withdrawal, order or trade path. */
const VENUE_FORM_PATH =
  /(^|\/)(transfers?|wires?|withdraw(?:als?)?|send(?:-?money)?|zelle|trades?|buy|sell|swap|place-?order|orders?)(\/|$)/;
const SUBMIT_SEG = /^(submit|confirm|place|create|execute|process|send|authorize|review)$/;

export function isVenueFormAction(method: string | undefined, action: string | undefined): boolean {
  if (action === undefined || (method ?? "get").toLowerCase() === "get") return false;
  let path = action;
  try {
    path = new URL(action, "https://example.invalid").pathname;
  } catch {
    // keep the raw text
  }
  const segs = path
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "");
  const last = segs.at(-1);
  if (last === undefined) return false;
  if (VENUE_FORM_PATH.test(`/${last}`)) return true;
  return SUBMIT_SEG.test(last) && segs.slice(0, -1).some((s) => VENUE_FORM_PATH.test(`/${s}`));
}

const CONFIRM_LABEL = new Set([
  "confirm",
  "submit",
  "send",
  "approve",
  "authorize",
  "authorise",
  "complete",
  "place",
  "execute",
  "finish",
  "done",
  "continue",
  "next",
]);
/** A page whose address or title says a transfer, a withdrawal or a trade is being made. */
const VENUE_CONTEXT =
  /(^|[\s/_-])(transfers?|wires?|withdraw(?:als?)?|send[- ]?money|zelle|pay[- ]?someone|trade|trading|order[- ]?ticket|place[- ]?order|buy|sell|swap|überweisung|virement|bonifico|transferencia|振込|送金|转账|이체|송금)([\s/_?#-]|$)/i;

export interface FinancialAction {
  /** Labels of the control and its parents, own label first. */
  labels?: readonly string[] | undefined;
  /** Browser: role of the control, whether it submits, and its form. */
  role?: string | undefined;
  submits?: boolean | undefined;
  formMethod?: string | undefined;
  formAction?: string | undefined;
  /** The page the control is on (a browser tab or a window of a browser app). */
  pageUrl?: string | undefined;
  pageTitle?: string | undefined;
  /** The executor could not read the control (a click at a point): refused on a venue. */
  unreadable?: boolean | undefined;
  /** Computer use: the app's bundle id. */
  app?: string | undefined;
  /** The origin the call targets. */
  origin?: string | undefined;
}

export interface FinancialBlock {
  venue: VenueKind | undefined;
  /** What matched: the label or the form path. */
  matched: string;
}

/** The refusal the owner reads; the hard block never offers a card. */
export const FINANCIAL_BLOCK_REASON =
  "Psyche never trades securities or crypto, moves money between bank accounts or sends money to a person, even if you approve. Do this one yourself in the app or on the site.";

/**
 * Whether acting on this control is a trade or a transfer that no approval unlocks. Undefined
 * for everything else: a checkout, a bill payment, reading a balance, a link that navigates.
 */
export function financialBlock(a: FinancialAction): FinancialBlock | undefined {
  const venue = venueOfApp(a.app) ?? venueOfHost(a.pageUrl) ?? venueOfHost(a.origin);
  const labels = (a.labels ?? []).filter((l) => l.trim() !== "");
  // An action the executor could not read, on a venue, could be the trade: refused, fail closed.
  if (a.unreadable === true) return venue === undefined ? undefined : { venue, matched: "" };
  // A link that only navigates never trades; the control that submits does.
  const navigation = (a.role === "link" || a.role === "AXLink") && a.submits !== true;
  if (!navigation) {
    // The control's own label gets the venue's verbs; its parents (a heading, a window) only the
    // phrases that are never anything else, so a Cancel button inside "Transfers" is not blocked.
    const own = labels[0];
    if (own !== undefined && isTradeOrTransferText(own, venue)) return { venue, matched: own };
    for (const l of labels.slice(1)) {
      if (isTradeOrTransferText(l)) return { venue, matched: l };
    }
  }
  if (venue === undefined) return undefined;
  if (a.submits === true && isVenueFormAction(a.formMethod, a.formAction)) {
    return { venue, matched: a.formAction ?? "" };
  }
  // "Confirm" on a venue's transfer or order page.
  const ownWords = moneyWords(labels[0] ?? "");
  if (
    !navigation &&
    ownWords.length > 0 &&
    ownWords.length <= 2 &&
    CONFIRM_LABEL.has(ownWords[0] ?? "") &&
    [a.pageUrl, a.pageTitle, ...labels.slice(1)].some((c) => c !== undefined && pageSaysTransfer(c))
  ) {
    return { venue, matched: labels[0] ?? "" };
  }
  return undefined;
}

function pageSaysTransfer(text: string): boolean {
  let s = text;
  try {
    const u = new URL(text);
    s = `${u.pathname} ${u.hash}`;
  } catch {
    // a title
  }
  return VENUE_CONTEXT.test(s.normalize("NFKC"));
}
