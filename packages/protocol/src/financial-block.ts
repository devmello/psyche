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
    // iPhone and iPad apps running on the Mac keep their iOS bundle ids
    "com.vilcsak.bitcoin2", // Coinbase
    "com.czzhao.binance", // Binance
    "com.electron.exodus", // Exodus desktop
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
    "com.navyfederal",
    "com.transferwise", // Wise on iOS
  ],
  p2p: [
    "com.venmo",
    "net.kortina.labs.venmo", // Venmo on iOS
    "com.squareup.cash",
    "com.zellepay",
    "com.westernunion",
    "com.remitly",
  ],
  p2p_mixed: ["com.paypal", "com.yourcompany.ppclient"],
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
  // "Buy stock", "Buy 10 stock": the singular only right after the verb or a quantity, so "Buy in
  // stock items" and "Sell my stock" (a shop's inventory) are not trades.
  new RegExp(
    `\\b(buy|short|trade|trading)\\s+(?:(?:\\d[\\d.,]*|a|some|more|this)\\s+)?stock\\b${STOCK_NOT_SHARES}`,
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
  // "Transfers" (plural) names a section or a tab; the verb is singular.
  "transfer",
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
  "発注",
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
/** What follows a CJK act and makes the pair a record of it ("振込履歴", "转账记录", "주문내역"). */
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
  "説明",
  "说明",
  "限度",
  "限额",
  "한도",
];
/** A sign-in code sent by text: "发送验证码" sends a code, not money. */
const CJK_SEND = ["发送", "發送", "送信", "보내기", "전송"];
const CJK_CODES = [
  "验证码",
  "驗證碼",
  "認証コード",
  "確認コード",
  "인증번호",
  "인증 번호",
  "인증코드",
];
const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An act word directly followed by a record word, or a send of a sign-in code. */
const CJK_NOT_ACT = new RegExp(
  `(?:${VENUE_CJK.map(escapeRe).join("|")})(?:の|的|\\s)?(?:${CJK_READS.map(escapeRe).join("|")})|(?:${CJK_SEND.map(escapeRe).join("|")})(?:\\s)?(?:${CJK_CODES.map(escapeRe).join("|")})|(?:${CJK_CODES.map(escapeRe).join("|")})(?:\\s)?(?:${CJK_SEND.map(escapeRe).join("|")})`,
  "g",
);

/**
 * Words that, right after a move verb ("Send code", "Transfer history", "Wire instructions"),
 * make the label about something else. Never applied to a trade verb on a brokerage: "Buy
 * options" and "Sell options" trade.
 */
const MOVE_NOT_ACTION = new Set([
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
  "activity",
  "instructions",
  "types",
  "type",
  "rules",
  "times",
  "guide",
]);
/** A sign-in code or a link sent to the owner: only after "send", never after "transfer". */
const SEND_NOT_ACTION = new Set([
  "code",
  "codes",
  "text",
  "sms",
  "otp",
  "passcode",
  "verification",
  "link",
  "message",
  "messages",
  "email",
  "feedback",
  "invite",
  "invitation",
]);
/** After a trade verb: reading about trading, not a trade ("Trade ideas", "Trade confirmations"). */
const TRADE_NOT_ACTION = new Set([
  "ideas",
  "idea",
  "history",
  "status",
  "details",
  "confirmations",
  "confirmation",
  "statements",
  "help",
  "faq",
  "guide",
  "info",
  "information",
  "reports",
  "report",
  "activity",
  "types",
  "rules",
  "times",
  "hours",
  "fees",
  "limits",
]);
const SEND_WORDS = new Set([
  "send",
  "enviar",
  "envoyer",
  "senden",
  "invia",
  "inviare",
  "отправить",
]);
const SKIP_BETWEEN = new Set(["a", "an", "the", "my", "your", "our", "this", "that", "me", "you"]);

/** The word after `i`, past articles and pronouns ("send a code", "send you a code"). */
function nextWord(words: readonly string[], i: number): string | undefined {
  let j = i + 1;
  while (j < words.length && SKIP_BETWEEN.has(words[j] ?? "")) j++;
  return words[j];
}

/** Removes invisible characters and stray marks a label can hide a word behind. */
function clean(text: string): string {
  return (
    text
      .normalize("NFKC")
      // format characters: soft hyphen, zero-width space and joiners, bidi controls, tag characters
      .replace(/\p{Cf}/gu, "")
      // variation selectors, Hangul fillers, the braille blank
      .replace(/[︀-️\u{E0100}-\u{E01EF}ㅤᅟᅠﾠ⠀]/gu, "")
      // a combining mark NFKC could not fold into a Latin, Greek or Cyrillic letter ("Bu̇y")
      .replace(/(?<=[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, "")
      // Arabic short vowels
      .replace(/[ً-ٰٟ]/g, "")
  );
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

/** A menu or a heading that only names a group of screens, not an act (not on a P2P app). */
const MENU_PHRASE = /^(?:pay\s*(?:&|and|\/)\s*transfer|transfer\s*(?:&|and|\/)\s*pay)$/;

export interface TextOptions {
  /** The page says it is a trade page (crypto, stocks): needed for trade words on a mixed venue. */
  tradePage?: boolean;
  /** A bank's rewards or travel site: buying a gift card there is a purchase, not a trade. */
  noTrade?: boolean;
  /** A tab or a menu: "Invest" names a section there, while "Buy" or "Transfer" still acts. */
  grouping?: boolean;
}

/** Whether `words[i]` is "order" (in any of the languages) used as the act of placing one. */
function isOrderAct(words: readonly string[], i: number, brokerage: boolean): boolean {
  const next = words[i + 1];
  if (next !== undefined && (TRADE_NOT_ACTION.has(next) || MOVE_NOT_ACTION.has(next))) return false;
  if (words.length === 1 || next === "ticket") return true;
  // "Place order", "Submit AAPL order", "Place my order", "Passer l'ordre".
  let seen = 0;
  for (let j = i - 1; j >= 0 && seen < 2; j--) {
    const w = words[j] ?? "";
    if (ARTICLES.has(w) || SKIP_BETWEEN.has(w)) continue;
    if (ORDER_VERBS.has(w)) return true;
    seen++;
  }
  // "Order 10 AAPL shares" on a brokerage.
  return brokerage && i === 0 && next !== undefined && /^\d/.test(next);
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
  if (kind !== "p2p" && MENU_PHRASE.test(norm)) return false;
  // A record of the act ("振込履歴") is not the act; what is left of the label still counts.
  const cjk = norm.replace(CJK_NOT_ACT, " ");
  if (VENUE_CJK.some((w) => cjk.includes(w))) return true;
  if (words.length === 0) return false;
  // Quotes, previews and lists move nothing.
  const first = words[0] ?? "";
  if (
    ["get", "list", "view", "show", "see", "read", "check", "history", "quote", "preview"].includes(
      first,
    )
  )
    return false;
  const trades = (kind !== "p2p_mixed" || opts.tradePage === true) && opts.noTrade !== true;
  const brokerage = kind === "brokerage" || kind === "exchange";
  if (trades && brokerage && /\bclose (?:my |this |the |your )?positions?\b/.test(spaced)) {
    return true;
  }
  // "Cash out" on a P2P app sends the balance to a bank.
  if (kind === "p2p" && /\bcash out\b/.test(spaced)) return true;
  for (const [i, w] of words.entries()) {
    const next = nextWord(words, i);
    if (trades && ORDER_WORDS.has(w)) {
      if (isOrderAct(words, i, brokerage)) return true;
      continue;
    }
    if (
      trades &&
      (VENUE_TRADE_WORDS.has(w) ||
        (brokerage && opts.grouping !== true && BROKERAGE_ONLY_WORDS.has(w)))
    ) {
      if (next !== undefined && TRADE_NOT_ACTION.has(next)) continue;
      return true;
    }
    if (VENUE_MOVE_WORDS.has(w)) {
      if (next !== undefined && MOVE_NOT_ACTION.has(next)) continue;
      // A P2P "Send link" is a request for money; elsewhere a link or a code is sign-in.
      if (
        SEND_WORDS.has(w) &&
        next !== undefined &&
        SEND_NOT_ACTION.has(next) &&
        !(kind === "p2p" && next === "link")
      )
        continue;
      // A word alone is enough on a venue, but "deposit" and "send" in a long sentence are not.
      if ((w === "deposit" || SEND_WORDS.has(w)) && words.length > 4) continue;
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

/** Path words that say money is being moved, inside a segment too ("transfer-money", "transferFunds"). */
const MOVE_STEMS = new Set([
  "transfer",
  "transfers",
  "wire",
  "wires",
  "withdraw",
  "withdrawal",
  "withdrawals",
  "zelle",
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
/** Two-word segments: "send-money", "move-money", "trade-ticket", "order-ticket", "place-order". */
const STEM_PAIRS: readonly (readonly [string, string])[] = [
  ["send", "money"],
  ["move", "money"],
  ["pay", "someone"],
  ["trade", "ticket"],
  ["order", "ticket"],
  ["place", "order"],
];
/** Segments that only count whole: "/buy" is a trade page, "/buy-the-dip-article" an article. */
const EXACT_SEGMENTS = new Set([
  "trade",
  "buy",
  "sell",
  "swap",
  "send",
  "sendmoney",
  "orderticket",
  "placeorder",
]);
/** A site's articles and help: a path word there names a topic, not a step. */
const ARTICLE_SEGMENTS = new Set([
  "education",
  "learn",
  "learning",
  "articles",
  "article",
  "news",
  "blog",
  "help",
  "faq",
  "insights",
  "research",
  "guides",
  "guide",
  "resources",
  "support",
]);
/** A title (or a part of one after a separator) that opens with the act. */
const TITLE_ACT =
  /^(?:(?:review|confirm|new|make|start)\s+(?:a\s+|an\s+|your\s+|the\s+)?)?(?:transfers?|wire|withdraw|send money|move money|zelle|trade|order ticket|place order|buy|sell|swap)\b/;

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

/** Tabs and menus group screens: only for an icon with no name there is a choice nothing reads. */
const GROUPING_ROLES =
  /^(tab|tablist|menu|menubar|AXTabGroup|AXMenuBar|AXMenuBarItem|AXRadioButton)$/;
/** Fields and containers clicked to type or to scroll, not to press. */
const FIELD_ROLES =
  /^(textbox|searchbox|combobox|spinbutton|slider|scrollbar|textarea|AXTextField|AXTextArea|AXComboBox|AXSearchField|AXSlider|AXScrollArea|AXScrollBar)$/;
/** A field Enter submits from; a search box or a combo box is a lookup. */
const TEXT_FIELD_ROLES = /^(textbox|textarea|AXTextField|AXTextArea)$/;

/** A GET form whose action is another page than the one it is on: a lookup that navigates. */
function getToAnotherPage(
  method: string | undefined,
  action: string | undefined,
  page: string | undefined,
): boolean {
  if ((method ?? "get").toLowerCase() !== "get" || action === undefined || page === undefined) {
    return false;
  }
  try {
    const x = new URL(action, page);
    const y = new URL(page);
    return x.origin !== y.origin || x.pathname !== y.pathname;
  } catch {
    return false;
  }
}

/** A link labelled as the final step ("Submit order", "Confirm transfer") is a step, not navigation. */
const STEP_VERBS = new Set([
  "submit",
  "confirm",
  "place",
  "execute",
  "authorize",
  "authorise",
  "complete",
]);

function isWalletHost(input: string | undefined): boolean {
  const host = financialHost(input);
  return host !== undefined && WALLET_EXTENSIONS.includes(host);
}

/** A bank's rewards, points or travel site (`ultimaterewardspoints.chase.com`): a shop, not a desk. */
function isRewardsHost(input: string | undefined): boolean {
  const host = financialHost(input);
  if (host === undefined) return false;
  const sub = host.split(".").slice(0, -2).join(".");
  return /(rewards|points|travel|shop|store)/.test(sub);
}

/** Whether a label has a letter or a digit once invisible characters are gone. */
const hasWord = (l: string): boolean => /[\p{L}\p{N}]/u.test(clean(l));

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
  const grouping = a.role !== undefined && GROUPING_ROLES.test(a.role) && a.submits !== true;
  const tradePage = [a.pageUrl, a.origin].some(
    (u) =>
      u !== undefined &&
      /(^|[/#?_-])(crypto|bitcoin|stocks?|invest|trade|buy|sell)([/#?_-]|$)/i.test(u),
  );
  const noTrade = venue === "bank" && (isRewardsHost(a.pageUrl) || isRewardsHost(a.origin));
  const opts = {
    tradePage,
    noTrade,
    grouping: a.role !== undefined && GROUPING_ROLES.test(a.role),
  };
  const own = labels[0];
  // A page dialog: its sentence, read for any trade or move word (a "Leave this page?" never is).
  if (a.role === "dialog") {
    if (own === undefined) return undefined;
    if (isTradeOrTransferText(own)) return { venue, matched: own };
    if (venue === undefined) return undefined;
    const wallet = isWalletHost(a.pageUrl) || isWalletHost(a.origin);
    const says =
      dialogSaysAct(own, venue) ||
      (wallet && wordsOf(clean(own)).some((w) => WALLET_ACTION_WORDS.has(w)));
    return says ? { venue, matched: own } : undefined;
  }
  // The control's own label gets the venue's verbs; a link that goes to another page only when it
  // names the final step ("Submit order"), since "Buy" or "Transfer money" in a menu navigates.
  if (own !== undefined && isTradeOrTransferText(own, venue, opts)) {
    const step = STEP_VERBS.has(wordsOf(clean(own))[0] ?? "");
    if (!navigation || step) return { venue, matched: own };
  }
  // The other end of a drag is pressed whatever the first end is.
  for (const l of a.alsoLabels ?? []) {
    if (isTradeOrTransferText(l, venue, opts)) return { venue, matched: l };
  }
  // Its parents (a heading, a window) only the phrases that are never anything else, so a Cancel
  // button inside "Transfers" is not blocked.
  if (!navigation) {
    for (const l of labels.slice(1)) {
      if (isTradeOrTransferText(l)) return { venue, matched: l };
    }
  }
  if (venue === undefined) return undefined;
  if (a.submits === true && isVenueFormAction(a.formMethod, a.formAction)) {
    return { venue, matched: a.formAction ?? "" };
  }
  // A drag onto a control with no name: what it presses cannot be read.
  if ((a.alsoLabels ?? []).some((l) => !hasWord(l))) return { venue, matched: "" };
  if (navigation) return undefined;
  // Enter in a text field submits its form, and a form's script may send anything: on a venue that
  // is unreadable, unless it is a search, or a GET that goes to another page. (A login form is
  // not marked as submitting by the browser, so it never gets here.)
  if (a.submits === true && a.role !== undefined && TEXT_FIELD_ROLES.test(a.role)) {
    if (!getToAnotherPage(a.formMethod, a.formAction, a.pageUrl)) return { venue, matched: "" };
  }
  // A control that was read and has no word in its name (an icon, an arrow) on a venue could be
  // the trade: unreadable. An action that read no control (a scroll, a Tab key) has no labels;
  // a field is clicked to type, and a tab or menu only groups screens.
  if (
    raw.length > 0 &&
    !hasWord(raw[0] ?? "") &&
    !grouping &&
    !(a.role !== undefined && FIELD_ROLES.test(a.role))
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

/** Leaving or cancelling never moves money, whatever the dialog says it will lose. */
const DIALOG_LEAVES = /^(?:leave|discard|cancel|stay|exit|close|log out|sign out|abandon|quit)\b/;

/** A confirm dialog's sentence names a trade or a move of money, with the same exemptions as a label. */
function dialogSaysAct(text: string, kind: VenueKind): boolean {
  const plain = clean(text).toLowerCase();
  const words = wordsOf(plain);
  if (DIALOG_LEAVES.test(words.join(" "))) return false;
  const cjk = plain.replace(CJK_NOT_ACT, " ");
  if (VENUE_CJK.some((w) => cjk.includes(w))) return true;
  return words.some((w, i) => {
    const next = nextWord(words, i);
    if (VENUE_TRADE_WORDS.has(w)) return !(next !== undefined && TRADE_NOT_ACTION.has(next));
    if (!VENUE_MOVE_WORDS.has(w) || (w === "deposit" && kind === "bank")) return false;
    if (next !== undefined && MOVE_NOT_ACTION.has(next)) return false;
    return !(SEND_WORDS.has(w) && next !== undefined && SEND_NOT_ACTION.has(next));
  });
}

/** The words of one path segment: split on `-`, `_`, `.` and camelCase. */
function segmentWords(seg: string): string[] {
  return seg
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[-_.\s]+/)
    .filter((w) => w !== "");
}

/** Whether an address's path (or hash route), or a part of a title, says a transfer or a trade. */
function pageSaysTransfer(text: string): boolean {
  let route: string | undefined;
  try {
    const u = new URL(text);
    route = `${u.pathname}/${u.hash.startsWith("#") ? u.hash.slice(1) : ""}`;
  } catch {
    // a title
  }
  if (route !== undefined) {
    const segs = route
      .normalize("NFKC")
      .split(/[/?#]/)
      .filter((s) => s !== "");
    if (segs.some((s) => ARTICLE_SEGMENTS.has(s.toLowerCase()))) return false;
    return segs.some((seg) => {
      const lower = seg.toLowerCase();
      if (EXACT_SEGMENTS.has(lower)) return true;
      const w = segmentWords(seg);
      if (
        w.some(
          (x, i) =>
            MOVE_STEMS.has(x) && !(w[i + 1] !== undefined && MOVE_NOT_ACTION.has(w[i + 1] ?? "")),
        )
      )
        return true;
      return STEM_PAIRS.some(([x, y]) => w.some((v, i) => v === x && w[i + 1] === y));
    });
  }
  // "Chase | Transfer money", "Capital One - Transfer Money": each part of the title.
  return clean(text)
    .toLowerCase()
    .split(/\s+[|–—:\-·]\s+|\s*[|–—·]\s*/)
    .some((part) => TITLE_ACT.test(part.replace(/\s+/g, " ").trim()));
}
