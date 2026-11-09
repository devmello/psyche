/**
 * Whether text, a name, a form or a page is about moving money. One rule for every surface that
 * decides `financial` (computer use labels, browser controls, MCP tools), because presence
 * (Touch ID or the Mac password) is asked for payments and nothing else: a miss lets a payment
 * through on a tap, a false match puts a sheet in front of an ordinary action.
 *
 * The rule is a money verb together with a money object ("send money", "place a stock market
 * order"), or a money verb with a currency amount ("Send $50"), or a short label that is nothing
 * but a payment verb ("Pay", "Sell", "Place bid"). A word alone ("transfer", "subscribe",
 * "checkout", "card") is not enough: it names git, files, newsletters and Slack cards just as
 * often. Navigation (a link, a GET) never pays; only the control that submits does. Browser-safe:
 * no Node imports (`@psyche/protocol/money-intent`).
 */

/** Words split on case, punctuation and underscores: `executeTrade` → ["execute", "trade"]. */
export function moneyWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
}

const VERB_STEMS = [
  "pay",
  "purchase",
  "buy",
  "transfer",
  "send",
  "trade",
  "bid",
  "sell",
  "swap",
  "withdraw",
  "tip",
  "donate",
  "deposit",
  "wire",
  "place",
  "execute",
  "complete",
  "confirm",
  "submit",
  "charge",
  "refund",
  "subscribe",
  "create",
] as const;

/** "pays", "paying", "sells", "selling" → the stem. */
function verbOf(word: string): string | undefined {
  for (const stem of VERB_STEMS) {
    if (word === stem) return stem;
    const base = stem.endsWith("e") ? stem.slice(0, -1) : stem;
    if (
      word === `${stem}s` ||
      word === `${base}ing` ||
      word === `${stem}es` ||
      (stem === "pay" && word === "pays")
    ) {
      return stem;
    }
    // "selling", "bidding", "tipping", "trading" double or drop a letter.
    if (word === `${stem}${stem.at(-1)}ing`) return stem;
  }
  return undefined;
}

/** Things that are money or a trade of it. Singular generic nouns only ("orders" is a list). */
const MONEY_OBJECTS = new Set([
  "money",
  "funds",
  "fund",
  "cash",
  "payment",
  "payments",
  "transaction",
  "transactions",
  "stock",
  "stocks",
  "share",
  "shares",
  "crypto",
  "bitcoin",
  "btc",
  "eth",
  "token",
  "tokens",
  "coin",
  "coins",
  "order",
  "bid",
  "trade",
  "purchase",
  "cart",
  "checkout",
  "usd",
  "eur",
  "gbp",
  "dollars",
  "euros",
  "payout",
  "payouts",
]);
/** Only after "pay": paying a bill pays, "send invoice" or "create invoice" does not. */
const PAY_OBJECTS = new Set(["invoice", "bill", "balance", "fee", "fees", "tax", "taxes", "rent"]);
const CARD_WORDS = new Set(["credit", "debit"]);
/** Verbs that, with a currency amount nearby, make the text a payment. */
const AMOUNT_VERBS = new Set([
  "pay",
  "send",
  "transfer",
  "withdraw",
  "tip",
  "buy",
  "sell",
  "bid",
  "swap",
  "donate",
  "deposit",
  "charge",
  "wire",
  "purchase",
  "place",
  "confirm",
  "submit",
  "complete",
  "subscribe",
]);
const AMOUNT = /[$€£¥]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|dollars?|euros?|btc|eth)\b/i;

/** A label that is nothing but a payment verb. */
const WHOLE_LABELS = new Set([
  "pay",
  "buy",
  "sell",
  "swap",
  "tip",
  "bid",
  "donate",
  "purchase",
  "book",
  "order",
  "reserve",
  "pay now",
  "buy now",
  "order now",
  "book now",
  "reserve now",
  "place order",
  "place your order",
  "place my order",
  "place the order",
  "place bid",
  "place a bid",
  "place your bid",
  "confirm and pay",
  "confirm and send",
  "confirm and buy",
  "complete purchase",
  "complete order",
  "complete payment",
  "complete checkout",
  "confirm purchase",
  "confirm order",
  "confirm payment",
  "confirm trade",
  "submit order",
  "submit payment",
  "submit bid",
  "make payment",
  "make a payment",
  "send money",
  "send payment",
  "send funds",
  "add funds",
  "execute trade",
  "pay with apple pay",
]);

/** "Pay with …" is a payment even with no object. */
const PAY_WITH = /\bpay (with|using|via|by)\b/;

/**
 * Whether a control label, tool name or description says a payment happens. Labels and names are
 * short; a description is checked sentence by sentence (a verb and an object four words apart).
 */
export function isMoneyText(text: string | undefined): boolean {
  if (text === undefined || text.trim() === "") return false;
  for (const sentence of text.split(/[.;:\n]+/)) {
    if (sentenceMoves(sentence)) return true;
  }
  return false;
}

function sentenceMoves(sentence: string): boolean {
  const words = moneyWords(sentence);
  if (words.length === 0) return false;
  const joined = words.join(" ");
  if (words.length <= 6 && WHOLE_LABELS.has(joined)) return true;
  if (PAY_WITH.test(joined)) return true;
  const hasAmount = AMOUNT.test(sentence);
  for (let i = 0; i < words.length; i++) {
    const verb = verbOf(words[i] ?? "");
    if (verb === undefined) continue;
    if (hasAmount && AMOUNT_VERBS.has(verb)) return true;
    // Money object within the next four words, in order.
    for (let j = i + 1; j <= i + 5 && j < words.length; j++) {
      const w = words[j] ?? "";
      if (MONEY_OBJECTS.has(w) && objectFits(verb, w)) return true;
      if (verb === "pay" && PAY_OBJECTS.has(w)) return true;
      if (CARD_WORDS.has(w) && words[j + 1] === "card") return true;
      // "Charges the card", "charge_card": charging a card is the payment.
      if (verb === "charge" && (w === "card" || w === "customer")) return true;
      if (w === "payment" && words[j + 1] === "card") return true;
      if (w === "bank" && words[j + 1] === "account") return true;
      if (w === "card" && words[j + 1] === "number") return true;
    }
  }
  return false;
}

/** "checkout" and "cart" are objects of finishing verbs only; "share" of trading ones. */
function objectFits(verb: string, object: string): boolean {
  // "create" only creates a payment or a payout (`create_payment_intent`), never an invoice or order.
  if (verb === "create") return ["payment", "payments", "payout", "payouts"].includes(object);
  if (object === "checkout" || object === "cart") {
    return ["complete", "confirm", "submit", "place", "pay", "execute"].includes(verb);
  }
  if (object === "share" || object === "shares" || object === "token" || object === "tokens") {
    return ["buy", "sell", "swap", "trade", "transfer", "send", "place", "execute"].includes(verb);
  }
  if (object === "order" || object === "bid" || object === "trade") {
    return ["place", "submit", "execute", "confirm", "complete", "buy", "sell", "pay"].includes(
      verb,
    );
  }
  return true;
}

/** Names of tools: a reading verb up front means the tool only reads about money. */
const READING_VERBS = new Set([
  "get",
  "list",
  "read",
  "search",
  "find",
  "fetch",
  "show",
  "view",
  "describe",
  "check",
  "lookup",
  "count",
  "query",
  "preview",
  "estimate",
  "calculate",
  "history",
]);
/** A tool named for just one of these verbs (`sell_stock`, `pay_invoice`) moves money. */
const NAME_VERBS = new Set([
  "pay",
  "buy",
  "purchase",
  "sell",
  "swap",
  "bid",
  "donate",
  "withdraw",
  "refund",
  "payout",
]);

/**
 * Whether an MCP tool's name says it moves money: `send_money`, `execute_trade`, `swap_tokens`,
 * `sell_stock`. `git_checkout`, `transfer_file`, `transfer_issue`, `subscribe_to_channel`,
 * `set_sort_order` and `create_invoice` do not.
 */
export function isMoneyToolName(name: string | undefined): boolean {
  if (name === undefined) return false;
  const words = moneyWords(name);
  const first = words[0];
  if (first === undefined || READING_VERBS.has(first)) return false;
  // A tool named for one of these verbs alone or at either end (`sell_stock`, `stripe.refund`).
  for (const w of [first, words.at(-1)]) {
    const verb = w === undefined ? undefined : verbOf(w);
    if (verb !== undefined && NAME_VERBS.has(verb)) return true;
    if (w === "payout" || w === "payouts") return true;
  }
  return sentenceMoves(words.join(" "));
}

// ---- Browser: forms and pages ----

const CARD_FIELD_TOKENS = [
  /\bcc ?(num|number|no)\b/,
  /\bcard ?(num|number|no)\b/,
  /\bcardnumber\b/,
  /\bccnumber\b/,
  /\bcredit ?card\b/,
  /\bdebit ?card\b/,
  /\bcvv\b/,
  /\bcvc\b/,
  /\bcsc\b/,
  /\bsecurity code\b/,
  /\bcard ?(exp|expiry|expiration)\b/,
  /\bcc ?(exp|expiry|expiration)\b/,
];
/** Cards that are not payment cards: a library card number is not a card number. */
const NOT_PAYMENT_CARD = new Set(["library", "loyalty", "membership", "student", "id", "sim"]);
const AUTOCOMPLETE_CARD = /^cc-(number|exp|exp-month|exp-year|csc)$/;

/**
 * Whether one form field is a payment card field: an `autocomplete` of `cc-number`, `cc-exp` or
 * `cc-csc`, or a card number, expiry or security code by name, id, label or placeholder. Never
 * `cc` alone (email CC), `library-card` or `card_pin`.
 */
export function isPaymentField(f: {
  autocomplete?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
}): boolean {
  const auto = (f.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (auto.some((t) => AUTOCOMPLETE_CARD.test(t))) return true;
  for (const text of [f.name, f.id, f.label, f.placeholder]) {
    if (text === undefined || text === "") continue;
    const words = moneyWords(text);
    if (words.some((w) => NOT_PAYMENT_CARD.has(w))) continue;
    const joined = words.join(" ");
    if (CARD_FIELD_TOKENS.some((re) => re.test(joined))) return true;
  }
  return false;
}

const MONEY_PATH_SEGMENTS = new Set([
  "checkout",
  "payment",
  "payments",
  "pay",
  "purchase",
  "buy",
  "sell",
  "swap",
  "bid",
  "trade",
  "transfer",
  "transfers",
  "withdraw",
  "withdrawal",
  "donate",
  "place-order",
  "cart",
  "order",
  "orders",
]);
const SUBMIT_PATH_SEGMENTS = new Set([
  "submit",
  "confirm",
  "place",
  "pay",
  "complete",
  "execute",
  "create",
  "process",
  "send",
  "authorize",
]);

/**
 * Whether submitting a form to this URL pays: a POST to `/checkout`, `/payment`, `/transfer/submit`,
 * `/orders/create`. A GET never does (`/orders/search`), and a POST to `/orders/search` ends in a
 * verb that is not a submit.
 */
export function isMoneyFormAction(method: string | undefined, action: string | undefined): boolean {
  if (action === undefined || (method ?? "post").toLowerCase() === "get") return false;
  let path = action;
  try {
    path = new URL(action, "https://example.invalid").pathname;
  } catch {
    // Keep the raw text.
  }
  const segs = path
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "");
  const last = segs.at(-1);
  if (last === undefined) return false;
  if (MONEY_PATH_SEGMENTS.has(last)) return true;
  return (
    SUBMIT_PATH_SEGMENTS.has(last) && segs.slice(0, -1).some((s) => MONEY_PATH_SEGMENTS.has(s))
  );
}

/** Short labels that only mean "go on": money only inside a payment form or page. */
const AMBIGUOUS_LABELS = new Set([
  "confirm",
  "send",
  "submit",
  "continue",
  "complete",
  "done",
  "ok",
  "approve",
  "authorize",
  "authorise",
  "proceed",
  "next",
  "yes",
  "place",
  "finish",
]);

export function isAmbiguousActionLabel(text: string | undefined): boolean {
  if (text === undefined) return false;
  const words = moneyWords(text);
  return words.length > 0 && words.length <= 2 && AMBIGUOUS_LABELS.has(words[0] ?? "");
}

const CONTEXT_PATH =
  /\/(checkout|payments?|pay|purchase|billing|transfer|withdraw|send-money)(\/|$)/i;
const CONTEXT_TITLE =
  /\b(checkout|check out|payment|billing|order summary|review (your |my )?order|pay(ing)? (now|for)|confirm (your )?(payment|order|purchase|transfer)|send money|transfer funds)\b/i;

/**
 * Whether a page or form is clearly about paying: it has card fields, its URL is a checkout or
 * payment path, or its title or heading says so. Bare "Confirm" or "Send" count only here.
 */
export function isMoneyContext(c: {
  url?: string | undefined;
  title?: string | undefined;
  hasPaymentFields?: boolean | undefined;
}): boolean {
  if (c.hasPaymentFields === true) return true;
  if (c.url !== undefined) {
    let path = c.url;
    try {
      path = new URL(c.url).pathname;
    } catch {
      // Keep the raw text.
    }
    if (CONTEXT_PATH.test(path)) return true;
  }
  return c.title !== undefined && CONTEXT_TITLE.test(c.title);
}
