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

export type VenueKind = "brokerage" | "exchange" | "bank" | "p2p" | "p2p_mixed";

/** Chrome ids of the wallet extensions: their popups confirm, approve and send on-chain. */
const WALLET_EXTENSIONS: readonly string[] = [
  "nkbihfbeogaeaoehlefnkodbefgpgknn", // MetaMask
  "bfnaelmomeimhlpmgjnjophhpkkoljpa", // Phantom
  "hnfanknocfeofbddgcijnmhnfnkdnaad", // Coinbase Wallet
  "acmacodkjbdgmoleebolmdjonilkdbch", // Rabby
];

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
    "ml.com",
    "thinkorswim.com",
    "morganstanley.com",
    "traderepublic.com",
    "scalable.capital",
    "sbisec.co.jp",
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
    "blockchain.com",
    "sushi.com",
    "curve.fi",
    "raydium.io",
    "opensea.io",
    "magiceden.io",
    "blur.io",
    "rarible.com",
    "polymarket.com",
    "kalshi.com",
    // Wallet extensions' own pages: `chrome-extension://<id>` has the id as its hostname.
    ...WALLET_EXTENSIONS,
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
    "jpmorgan.com",
    "transferwise.com",
  ],
  // Pure peer-to-peer: even a bare "Pay" is a payment to a person.
  p2p: [
    "venmo.com",
    "cash.app",
    "zellepay.com",
    "zelle.com",
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

/** Every app prefix above, for the lists that must stay in step with it (`apps.ts` locks them off). */
export const FINANCIAL_APP_PREFIXES: readonly string[] = Object.values(APP_VENUES).flat();

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

/** Securities and crypto a phrase can name. "Stock" alone is handled apart: stock photos, stock rooms. */
const SECURITY_OBJECT =
  "(stocks|shares?|etfs?|equit(?:y|ies)|bonds?|futures|forex|securit(?:y|ies)|crypto(?:currency|currencies)?|bitcoins?|btc|ethereum|eth|dogecoin|doge|xrp|usdc|usdt)";
/** What a singular "stock" is not a share of: media, a store room, a stock market page. */
const STOCK_NOT_SHARES =
  "(?!\\s+(?:photos?|images?|pictures?|footage|videos?|music|illustrations?|vectors?|assets?|art|library|room|rooms|market|levels?|count|keeping|control|exchange))";

/** Phrases that trade or move money wherever they appear: no merchant checkout is labelled so. */
const UNIVERSAL: readonly RegExp[] = [
  new RegExp(`\\b(buy|sell|short|trade|trading)\\s+(?:\\w+\\s+){0,2}${SECURITY_OBJECT}\\b`),
  new RegExp(`\\b(buy|short|trade|trading)\\s+(?:\\w+\\s+){0,2}stock\\b${STOCK_NOT_SHARES}`),
  new RegExp(
    `\\bsell\\s+(?:my |all |your |the |some |\\d+ )(?:\\w+\\s+){0,1}stock\\b${STOCK_NOT_SHARES}`,
  ),
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

/** On a venue the verbs themselves are enough ("Buy", "Sell", "Swap"). */
const VENUE_TRADE_WORDS = new Set([
  "buy",
  "sell",
  "short",
  "trade",
  "swap",
  "stake",
  "unstake",
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
  "اشتر",
  "اشتري",
  "بيعي",
  "खरीदें",
  "बेचें",
  "खरीदे",
  "बेचे",
]);
/** Only on a brokerage or an exchange: "Invest" on a bank is a menu, "Exercise" an option. */
const BROKERAGE_ONLY_WORDS = new Set([
  "invest",
  "exercise",
  "convert",
  "investir",
  "invertir",
  "investieren",
]);
/** "Order" is a trade alone or after one of these ("Place order", "Passer l'ordre", "Conferma ordine"). */
const ORDER_WORDS = new Set(["order", "ordre", "ordine", "orden", "ordem", "auftrag"]);
const ORDER_VERBS = new Set([
  "place",
  "submit",
  "review",
  "confirm",
  "preview",
  "execute",
  "limit",
  "market",
  "stop",
  "new",
  "create",
  "send",
  "passer",
  "placer",
  "valider",
  "confirmer",
  "conferma",
  "confermare",
  "effettua",
  "passa",
  "confirmar",
  "colocar",
  "realizar",
  "hacer",
  "enviar",
  "aufgeben",
  "erteilen",
  "bestätigen",
  "platzieren",
]);
const ARTICLES = new Set([
  "a",
  "an",
  "the",
  "my",
  "your",
  "l",
  "le",
  "la",
  "les",
  "el",
  "un",
  "une",
  "una",
  "uma",
  "der",
  "die",
  "das",
  "den",
  "il",
  "lo",
  "o",
  "os",
  "as",
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
  "pix",
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
  "отправить",
  "отправь",
  "отправка",
  "تحويل",
  "سحب",
  "إرسال",
  "ارسال",
  "أرسل",
  "ارسل",
  "ट्रांसफर",
  "निकासी",
  "भेजें",
  "भेजे",
  "भेजना",
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
  "購入",
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
  "提币",
  "提幣",
  "转出",
  "轉出",
  "买入",
  "買入",
  "卖出",
  "賣出",
  "购买",
  "購買",
  "下单",
  "下單",
  "交易",
  "兑换",
  "兌換",
  "发送",
  "發送",
  "이체",
  "송금",
  "출금",
  "보내기",
  "매수",
  "매도",
  "구매",
  "주문",
];
/** A CJK label that is about a past or a status ("order history", "transfer record"), not the act. */
const CJK_READS = [
  "履歴",
  "履歷",
  "记录",
  "記錄",
  "明细",
  "明細",
  "내역",
  "照会",
  "一覧",
  "查询",
  "查詢",
  "状況",
  "状态",
  "狀態",
  "历史",
  "歷史",
  "验证码",
  "驗證碼",
  "認証",
  "인증",
  "説明",
  "说明",
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
  "confirmations",
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
  // a code or a link sent for signing in, a menu, an article
  "code",
  "codes",
  "text",
  "sms",
  "otp",
  "passcode",
  "verification",
  "link",
  "instructions",
  "activity",
  "ideas",
  "types",
  "type",
  "rules",
  "times",
  "options",
  "guide",
]);

/** Removes invisible format characters (soft hyphen, zero-width joiner, bidi marks) and Arabic marks. */
function clean(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[ً-ٰٟ]/g, "");
}

/** Words as `moneyWords` splits them, keeping combining marks (Hindi, Arabic vowels) in their word. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
}

/** A menu or a heading that only names a group of screens, not an act. */
const MENU_PHRASE = /^(?:pay\s*(?:&|and|\/)\s*transfer|transfer\s*(?:&|and|\/)\s*pay)$/;

export interface TextOptions {
  /** The page says it is a trade page (crypto, stocks): needed for trade words on a mixed venue. */
  tradePage?: boolean;
}

/**
 * Whether one label, name or sentence is a trade or a transfer of money on a venue of `kind`, or
 * (with no venue) one of the phrases that are never anything else.
 */
export function isTradeOrTransferText(
  text: string | undefined,
  kind?: VenueKind,
  opts: TextOptions = {},
): boolean {
  if (text === undefined || text.trim() === "") return false;
  const plain = clean(text);
  const norm = plain.toLowerCase().replace(/\s+/g, " ").trim();
  // Words are split the way tool names are, so `executeTrade` and `place_order` read as phrases.
  const words = wordsOf(plain);
  const spaced = words.join(" ");
  if (UNIVERSAL.some((re) => re.test(norm) || re.test(spaced))) return true;
  if (kind === undefined) return false;
  if (MENU_PHRASE.test(norm)) return false;
  if (CJK_READS.some((w) => norm.includes(w))) return false;
  if (VENUE_CJK.some((w) => norm.includes(w))) return true;
  if (words.length === 0) return false;
  // Quotes, previews and lists move nothing.
  const first = words[0] ?? "";
  if (
    ["get", "list", "view", "show", "see", "read", "check", "history", "quote", "preview"].includes(
      first,
    )
  )
    return false;
  const trades = kind !== "p2p_mixed" || opts.tradePage === true;
  const brokerage = kind === "brokerage" || kind === "exchange";
  if (trades && brokerage && /\bclose (?:my |this |the |your )?positions?\b/.test(spaced)) {
    return true;
  }
  // "Cash out" on a P2P app sends the balance to a bank.
  if (kind === "p2p" && /\bcash out\b/.test(spaced)) return true;
  for (const [i, w] of words.entries()) {
    const next = words[i + 1];
    const notAction = next !== undefined && NOT_THE_ACTION.has(next);
    if (trades && ORDER_WORDS.has(w)) {
      let j = i - 1;
      while (j >= 0 && ARTICLES.has(words[j] ?? "")) j--;
      const prev = j >= 0 ? words[j] : undefined;
      const alone = words.length === 1;
      if (
        (alone || (prev !== undefined && ORDER_VERBS.has(prev)) || next === "ticket") &&
        !notAction
      )
        return true;
      continue;
    }
    if (
      trades &&
      !notAction &&
      (VENUE_TRADE_WORDS.has(w) || (brokerage && BROKERAGE_ONLY_WORDS.has(w)))
    ) {
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

/** A bare step button on a transfer or order page: "Confirm", "Submit", "Next", "Jetzt ausführen". */
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
  // de / es / pt / fr / it
  "bestätigen",
  "bestätige",
  "bestaetigen",
  "ausführen",
  "ausfuehren",
  "weiter",
  "absenden",
  "confirmar",
  "ejecutar",
  "executar",
  "continuar",
  "enviar",
  "confirmer",
  "valider",
  "exécuter",
  "continuer",
  "envoyer",
  "conferma",
  "confermare",
  "eseguire",
  "continua",
  "invia",
  "подтвердить",
  "продолжить",
  "تأكيد",
  "تاكيد",
  "पुष्टि",
]);
const CONFIRM_CJK = [
  "确认",
  "確認",
  "确定",
  "確定",
  "提交",
  "送信",
  "実行",
  "次へ",
  "完了",
  "下一步",
  "확인",
  "제출",
  "실행",
  "다음",
];
/** The words of a wallet popup that sign or send on-chain. */
const WALLET_ACTION_WORDS = new Set([
  "confirm",
  "approve",
  "sign",
  "send",
  "swap",
  "bridge",
  "accept",
  "authorize",
  "stake",
]);

/** Path segments that say a transfer, a withdrawal, a wire or a trade is being made. */
const CONTEXT_SEGMENTS = new Set([
  "transfer",
  "transfers",
  "wire",
  "wires",
  "withdraw",
  "withdrawal",
  "withdrawals",
  "send",
  "sendmoney",
  "send-money",
  "zelle",
  "pay-someone",
  "trade",
  "order-ticket",
  "orderticket",
  "place-order",
  "placeorder",
  "buy",
  "sell",
  "swap",
  "überweisung",
  "ueberweisung",
  "überweisungen",
  "transferencia",
  "transferencias",
  "transferir",
  "virement",
  "virements",
  "bonifico",
  "bonifici",
  "振込",
  "送金",
  "转账",
  "이체",
  "송금",
]);
/** A title that opens with the act ("Transfer money", "Review your transfer", "Buy AAPL"). */
const TITLE_ACT =
  /^(?:(?:review|confirm|new|make|start)\s+(?:a\s+|an\s+|your\s+|the\s+)?)?(?:transfers?|wire|withdraw|send money|zelle|trade|order ticket|place order|buy|sell|swap)\b/;

export interface FinancialAction {
  /** Labels of the control and its parents, own label first. */
  labels?: readonly string[] | undefined;
  /** Other controls the same action also activates (the far end of a drag): each is judged as an own label. */
  alsoLabels?: readonly string[] | undefined;
  /** Browser: role of the control, whether it submits, and its form. */
  role?: string | undefined;
  submits?: boolean | undefined;
  /** A link's target, as the page gave it: only a real web address counts as navigation. */
  href?: string | undefined;
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

const withoutFragment = (u: string): string => {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href;
  } catch {
    return u;
  }
};

/**
 * A link navigates when it goes to another web page. `javascript:`, `#` and a missing target are
 * script, and the control may do anything. A native link of a Mac app (`AXLink`) always navigates.
 */
function isNavigation(a: FinancialAction): boolean {
  if (a.submits === true) return false;
  if (a.role === "AXLink") return true;
  if (a.role !== "link") return false;
  if (a.href === undefined || !/^https?:\/\//i.test(a.href.trim())) return false;
  return a.pageUrl === undefined || withoutFragment(a.href.trim()) !== withoutFragment(a.pageUrl);
}

/** Tabs and menus group screens; choosing one does not move money. */
const GROUPING_ROLES =
  /^(tab|tablist|menu|menubar|AXTabGroup|AXMenuBar|AXMenuBarItem|AXRadioButton)$/;
/** Roles an empty-labelled control is still pressed through. */
const PRESS_ROLES = /^(button|clickable|menuitem|link|AXButton|AXMenuItem|AXMenuButton|AXLink)$/;

function isWalletHost(input: string | undefined): boolean {
  const host = financialHost(input);
  return host !== undefined && WALLET_EXTENSIONS.includes(host);
}

/**
 * Whether acting on this control is a trade or a transfer that no approval unlocks. Undefined
 * for everything else: a checkout, a bill payment, reading a balance, a link that navigates.
 */
export function financialBlock(a: FinancialAction): FinancialBlock | undefined {
  const venue = venueOfApp(a.app) ?? venueOfHost(a.pageUrl) ?? venueOfHost(a.origin);
  const raw = a.labels ?? [];
  const labels = raw.filter((l) => l.trim() !== "");
  // An action the executor could not read, on a venue, could be the trade: refused, fail closed.
  if (a.unreadable === true) return venue === undefined ? undefined : { venue, matched: "" };
  const navigation = isNavigation(a);
  const grouping = a.role !== undefined && GROUPING_ROLES.test(a.role);
  const tradePage = [a.pageUrl, a.origin].some(
    (u) =>
      u !== undefined &&
      /(^|[/#?_-])(crypto|bitcoin|stocks?|invest|trade|buy|sell)([/#?_-]|$)/i.test(u),
  );
  if (!navigation && !grouping) {
    // The control's own label gets the venue's verbs; its parents (a heading, a window) only the
    // phrases that are never anything else, so a Cancel button inside "Transfers" is not blocked.
    const own = labels[0];
    if (own !== undefined && isTradeOrTransferText(own, venue, { tradePage })) {
      return { venue, matched: own };
    }
    for (const l of a.alsoLabels ?? []) {
      if (isTradeOrTransferText(l, venue, { tradePage })) return { venue, matched: l };
    }
    for (const l of labels.slice(1)) {
      if (isTradeOrTransferText(l)) return { venue, matched: l };
    }
  }
  if (venue === undefined) return undefined;
  if (a.submits === true && isVenueFormAction(a.formMethod, a.formAction)) {
    return { venue, matched: a.formAction ?? "" };
  }
  if (navigation || grouping) return undefined;
  // A page dialog on a venue ("Sell 10 shares?"): its sentence is read for any trade or move word.
  if (a.role === "dialog" && dialogSaysAct(labels[0] ?? "")) {
    return { venue, matched: labels[0] ?? "" };
  }
  // A control that was read and has no name at all (an icon button) on a venue could be the
  // trade: unreadable. An action that read no control (a scroll, a Tab key) has no labels.
  if (
    raw.length > 0 &&
    (raw[0] ?? "").trim() === "" &&
    (a.submits === true || a.role === undefined || PRESS_ROLES.test(a.role))
  ) {
    return { venue, matched: "" };
  }
  const ownText = clean(labels[0] ?? "");
  const ownWords = wordsOf(ownText);
  // A wallet's popup: Confirm, Approve, Sign or Send signs a transaction.
  if (
    (isWalletHost(a.pageUrl) || isWalletHost(a.origin)) &&
    ownWords.some((w) => WALLET_ACTION_WORDS.has(w))
  ) {
    return { venue, matched: labels[0] ?? "" };
  }
  // "Confirm" on a venue's transfer or order page.
  const confirmLabel =
    (ownWords.length > 0 && ownWords.length <= 2 && ownWords.some((w) => CONFIRM_LABEL.has(w))) ||
    (ownText.length <= 8 && CONFIRM_CJK.some((w) => ownText.includes(w)));
  if (
    confirmLabel &&
    [a.pageUrl, a.pageTitle, ...labels.slice(1)].some((c) => c !== undefined && pageSaysTransfer(c))
  ) {
    return { venue, matched: labels[0] ?? "" };
  }
  return undefined;
}

/** A confirm dialog's sentence names a trade or a move of money anywhere in it. */
function dialogSaysAct(text: string): boolean {
  const plain = clean(text).toLowerCase();
  if (VENUE_CJK.some((w) => plain.includes(w))) return true;
  return wordsOf(plain).some(
    (w) => VENUE_TRADE_WORDS.has(w) || (VENUE_MOVE_WORDS.has(w) && w !== "deposit"),
  );
}

/** Whether an address's path (or hash route), or a title that opens with the act, is a transfer or a trade. */
function pageSaysTransfer(text: string): boolean {
  let route: string | undefined;
  try {
    const u = new URL(text);
    route = `${u.pathname}${u.hash.startsWith("#") ? u.hash.slice(1) : ""}`;
  } catch {
    // a title
  }
  if (route !== undefined) {
    return route
      .normalize("NFKC")
      .toLowerCase()
      .split(/[/?#]/)
      .some((seg) => CONTEXT_SEGMENTS.has(seg));
  }
  return TITLE_ACT.test(clean(text).toLowerCase().replace(/\s+/g, " ").trim());
}
