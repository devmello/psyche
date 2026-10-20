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
  /** Decimal amount and ISO currency parsed from `total`, when unambiguous. */
  amount?: string;
  currency?: string;
  /** `sha256:` over the canonical item list (names, quantities, prices). */
  lineItemHash: string;
}

const MONEY =
  /(?:US\$|[$€£¥₹]|\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD)\b)\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:€|\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD)\b)/i;
const TOTAL_LABEL =
  /^(?:order\s+total|grand\s+total|total(?:\s+due)?|amount\s+due|you\s+pay)\b\s*:?\s*/i;
const NOT_ITEM =
  /^(?:sub\s?total|total|grand total|tax|vat|shipping|delivery|discount|fees?|item|product)\b/i;
const SELLER = /^(?:seller|sold\s+by|merchant|store)\b\s*:?\s*/i;
const SYMBOLS: Record<string, string> = {
  $: "USD",
  US$: "USD",
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

function parseMoney(total: string): { amount?: string; currency?: string } {
  const m = MONEY.exec(total);
  if (m === null) return {};
  const text = m[0];
  const digits = /\d[\d,]*(?:\.\d{1,2})?/.exec(text)?.[0]?.replace(/,/g, "");
  const code =
    /\b(USD|EUR|GBP|JPY|INR|CAD|AUD)\b/i.exec(text)?.[1]?.toUpperCase() ??
    SYMBOLS[/US\$|[$€£¥₹]/.exec(text)?.[0] ?? ""];
  return {
    ...(digits === undefined ? {} : { amount: digits }),
    ...(code === undefined ? {} : { currency: code }),
  };
}

export function readOrder(snapshotText: string, merchantOrigin: string): OrderSummary {
  const lines = snapshotText.split("\n").map(parseLine);
  let seller: string | undefined;
  let total: string | undefined;
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
      total = clean(price, 40);
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
      if (m !== null) total = clean(m[0], 40);
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
    ...(total === undefined ? {} : { total, ...parseMoney(total) }),
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
