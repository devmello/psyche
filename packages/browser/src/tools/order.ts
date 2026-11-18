import { createHash } from "node:crypto";

/**
 * What a checkout page says it is about to buy (INT-2 scenario 1: "a confirm card listing
 * seller, items and total"; data model §4.2 `purchase` binding: merchant origin, amount,
 * currency, line-item hash, payment method id). Read from the model-visible snapshot text, so
 * every field is untrusted page content: the card shows it as "as shown on the page", the
 * merchant origin comes from the tab, not the page, and the executor re-reads the page before
 * clicking and refuses when the order changed since the approval (`order_changed`).
 */
export interface OrderLine {
  name: string;
  quantity?: string;
  price?: string;
}

export interface OrderSummary {
  /** The tab's origin: the only field not taken from page text. */
  merchantOrigin: string;
  /** "Seller: …" / "Sold by …" text, when the page states one. */
  seller?: string;
  items: OrderLine[];
  /** The total as printed, e.g. `$29.00`. */
  total?: string;
  /** The page's whole total text (the line or cell), for the card to quote. */
  totalText?: string;
  /** Decimal amount and ISO currency parsed from `total`, when unambiguous. */
  amount?: string;
  currency?: string;
  /** `sha256:` over the canonical item list (names, quantities, prices). */
  lineItemHash: string;
}

// The number is taken whole (digits, commas and dots) so a separator style we do not read is seen
// as such, never cut to a shorter amount; `parseMoney` then accepts only unambiguous shapes.
// Any letters right before a `$` are part of the symbol (`HK$`, `R$`), so an unknown dollar is
// seen as one and refused, never read as US dollars.
const MONEY =
  /(?:[A-Za-z]{1,3}\$|[$€£¥₹]|\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD)\b)\s?\d[\d,.]*|\d[\d,.]*\s?(?:€|\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD)\b)/i;
/** Every ISO 4217 code this runtime knows, so `HKD` or `CAD` anywhere on the line is seen. */
const ISO_CODES = new Set<string>([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "INR",
  "CAD",
  "AUD",
  ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : []),
]);
/** A digit group split by a space (`1 234`): a thousands style we do not read. */
const SPACE = "[ \u00a0\u2007\u2009\u202f]";
const TOTAL_LABEL =
  /^(?:order\s+total|grand\s+total|total(?:\s+due)?|amount\s+due|you\s+pay)\b\s*:?\s*/i;
const NOT_ITEM =
  /^(?:sub\s?total|total|grand total|tax|vat|shipping|delivery|discount|fees?|item|product)\b/i;
const SELLER = /^(?:seller|sold\s+by|merchant|store)\b\s*:?\s*/i;
const SYMBOLS: Record<string, string> = {
  $: "USD",
  US$: "USD",
  CA$: "CAD",
  C$: "CAD",
  AU$: "AUD",
  A$: "AUD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

/** Control and bidirectional-override characters a page could use to disguise a card line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this regex exists to strip them
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** Page strings are capped and stripped of control characters before they reach a card. */
function clean(s: string, max = 80): string {
  return s.replace(UNSAFE_CHARS, "").trim().slice(0, max);
}

/** `- role "name"` → [role, name]; the snapshot escapes quotes as JSON does. */
function parseLine(line: string): { depth: number; role: string; name?: string } | undefined {
  const m = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
  if (m === null) return undefined;
  let name: string | undefined;
  if (m[3] !== undefined) {
    try {
      name = JSON.parse(`"${m[3]}"`) as string;
    } catch {
      name = m[3];
    }
  }
  return { depth: (m[1] ?? "").length, role: m[2] ?? "", ...(name === undefined ? {} : { name }) };
}

/**
 * Amount and ISO currency of a printed price, or `{}` when either is ambiguous (a wrong guess is
 * a 100x payment or the wrong currency). Read only:
 * - `1234` or `1,234` groups of three, with a `.` and one or two decimals; `12,00`, `1.299,00`,
 *   `1,2345` and space-grouped `1 234.00` are refused;
 * - `$`, `US$` (USD), `CA$` / `C$` (CAD), `AU$` / `A$` (AUD), `€`, `£`, `¥`, `₹` and the ISO
 *   codes; any other letter-prefixed dollar (`HK$`, `NZ$`, `R$`) is refused;
 * - one currency: a symbol and a code that disagree (`€12.00 USD`) are refused.
 */
export function parseMoney(
  cell: string,
  /** The whole line or row the cell sits in: its codes and look-alikes count too. */
  context?: string,
): { amount?: string; currency?: string } {
  // The amount is the cell's own; the checks look at the whole row around it.
  const text = context ?? cell;
  const at = context === undefined ? 0 : context.lastIndexOf(cell);
  if (at < 0) return {};
  const re = new RegExp(MONEY.source, "gi");
  re.lastIndex = at;
  const m = re.exec(text);
  if (m === null) return {};
  const s = m[0];
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + s.length);
  const symbol = /^(?:[A-Za-z]{1,3}\$|[$€£¥₹])/.exec(s)?.[0];
  if (symbol !== undefined) {
    // Only the known symbols, and nothing that could make one a different currency: letters of
    // any script or invisible format characters at the symbol (`НК$`, `HK\u200b$`), or a short
    // capitalised word one space before it (`HK $`, `NZ $`).
    if (/[A-Za-z]/.test(symbol) && SYMBOLS[symbol.toUpperCase()] === undefined) return {};
    if (/[\p{L}\p{M}\p{Cf}]$/u.test(before) || /\p{Cf}/u.test(before.slice(-3))) return {};
    // `HK $12`, or `HK | $12` across table cells.
    const near = `${SPACE}?(?:\\|${SPACE}?)?$`;
    if (new RegExp(`(?:^|[^\\p{L}])\\p{Lu}{1,3}${near}`, "u").test(before)) return {};
  }
  if (/\p{Cf}/u.test(s)) return {};
  // A negative or bracketed (accounting) total is a refund or a credit, never a payment.
  if (new RegExp(`[-−‐‑–—(]${SPACE}?$`).test(before)) return {};
  const currencies = new Set<string>();
  if (symbol !== undefined) currencies.add(SYMBOLS[symbol.toUpperCase()] ?? "");
  if (/€$/.test(s)) currencies.add("EUR");
  // Any currency code on the whole line or row must be the same one (`$100.00 HKD`,
  // `Total (CAD): $12.00`, `€12.00 USD`).
  for (const c of text.matchAll(/(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])/g)) {
    const code = c[0].toUpperCase();
    if (
      ISO_CODES.has(code) &&
      (c[0] === code || code === s.match(/[A-Za-z]{3}/)?.[0]?.toUpperCase())
    ) {
      currencies.add(code);
    }
  }
  if (currencies.size > 1) return {};
  const currency = [...currencies][0];
  const token = /\d[\d,.]*/.exec(s)?.[0] ?? "";
  const trimmed = token.replace(/[.,]+$/, "");
  const split =
    new RegExp(`\\d${SPACE}$|[.,]$`).test(before) || new RegExp(`^${SPACE}\\d`).test(after);
  const digits =
    !split && /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(trimmed)
      ? trimmed.replace(/,/g, "")
      : undefined;
  if (digits === undefined) return currency === undefined ? {} : { currency };
  return { amount: digits, ...(currency === undefined ? {} : { currency }) };
}

export function readOrder(snapshotText: string, merchantOrigin: string): OrderSummary {
  const lines = snapshotText.split("\n").map(parseLine);
  let seller: string | undefined;
  let total: string | undefined;
  let totalText: string | undefined;
  /** The cell or line the total amount is read from (the row's last amount). */
  let totalCell: string | undefined;
  const items: OrderLine[] = [];
  let row: string[] | undefined;
  let rowDepth = -1;

  const endRow = () => {
    if (row === undefined) return;
    const cells = row;
    row = undefined;
    const first = cells[0] ?? "";
    const price = [...cells].reverse().find((c) => MONEY.test(c));
    if (TOTAL_LABEL.test(first) && price !== undefined) {
      total = clean(MONEY.exec(price)?.[0] ?? price, 40);
      // The amount from the total's own cell; the whole row is quoted and checked (a currency
      // code or look-alike in another cell still counts).
      totalCell = clean(price);
      totalText = clean(cells.join(" | "), 120);
      return;
    }
    if (price === undefined || NOT_ITEM.test(first) || first === "" || items.length >= 10) return;
    const quantity = cells.slice(1).find((c) => /^\d{1,4}$/.test(c));
    items.push({
      name: clean(first),
      ...(quantity === undefined ? {} : { quantity }),
      price: clean(price, 40),
    });
  };

  for (const l of lines) {
    if (l === undefined) continue;
    if (row !== undefined && l.depth <= rowDepth) endRow();
    if (l.role === "row") {
      row = [];
      rowDepth = l.depth;
      continue;
    }
    if (row !== undefined && (l.role === "cell" || l.role === "gridcell")) {
      row.push(l.name ?? "");
      continue;
    }
    const text = l.name;
    if (text === undefined || row !== undefined) continue;
    if (seller === undefined && SELLER.test(text)) {
      const v = clean(text.replace(SELLER, ""));
      if (v !== "") seller = v;
    } else if (TOTAL_LABEL.test(text) && !/^sub\s?total/i.test(text)) {
      const m = MONEY.exec(text);
      if (m !== null) {
        total = clean(m[0], 40);
        totalText = clean(text);
        totalCell = totalText;
      }
    }
  }
  endRow();

  const lineItemHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(items.map((i) => [i.name, i.quantity ?? null, i.price ?? null])))
    .digest("hex")}`;
  return {
    merchantOrigin,
    ...(seller === undefined ? {} : { seller }),
    items,
    ...(total === undefined
      ? {}
      : {
          total,
          ...(totalText === undefined ? {} : { totalText }),
          ...parseMoney(totalCell ?? total, totalText),
        }),
    lineItemHash,
  };
}

/** The card's one line: what, from whom, for how much, with the page's words quoted. */
export function orderSummary(action: string, o: OrderSummary): string {
  const host = (() => {
    try {
      return new URL(o.merchantOrigin).host;
    } catch {
      return o.merchantOrigin;
    }
  })();
  const parts = [`${action} on ${host}`];
  if (o.seller !== undefined) parts.push(`seller "${o.seller}"`);
  if (o.items.length > 0) {
    const list = o.items
      .slice(0, 3)
      .map(
        (i) =>
          `${i.quantity === undefined ? "" : `${i.quantity} × `}"${i.name}"${i.price === undefined ? "" : ` ${i.price}`}`,
      )
      .join(", ");
    parts.push(o.items.length > 3 ? `${list} and ${o.items.length - 3} more` : list);
  }
  parts.push(o.total === undefined ? "total not shown on the page" : `total ${o.total}`);
  return `${parts.join("; ")} (as shown on the page)`;
}

/** Data model §4.2 `purchase` binding. The browser never knows the payment method. */
export function orderBinding(o: OrderSummary, submitName: string) {
  return {
    merchantOrigin: o.merchantOrigin,
    amount: o.amount ?? null,
    currency: o.currency ?? null,
    lineItemHash: o.lineItemHash,
    paymentMethodId: null,
    submit: submitName,
  };
}

/**
 * True when a fresh read of the checkout still shows what the owner approved: the same merchant,
 * and, for whatever the approved read showed, the same total and the same line items. A field
 * the approved read did not show (a total below the fold) is not compared.
 */
export function orderStillMatches(approved: OrderSummary, fresh: OrderSummary): boolean {
  if (approved.merchantOrigin !== fresh.merchantOrigin) return false;
  if (approved.total !== undefined && approved.total !== fresh.total) return false;
  if (approved.items.length > 0 && approved.lineItemHash !== fresh.lineItemHash) return false;
  return true;
}
