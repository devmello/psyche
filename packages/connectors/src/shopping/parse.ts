import type { SnapshotRef } from "@psyche/protocol";

/**
 * Storefront parsing for the shopping helpers (feature M10). Pages are untrusted text and
 * accessibility refs from the browser driver; nothing here follows instructions found in them.
 * The parsers are deliberately simple: a line with one price is an offer, the text before the
 * price is its name, `Add to cart` buttons pair with offers in page order.
 */

export interface Money {
  /** Minor units (cents). */
  amountMinor: number;
  /** ISO 4217. */
  currency: string;
  display: string;
}

const SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};
const CODES = new Set([
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "JPY",
  "INR",
  "SEK",
  "NOK",
  "DKK",
  "NZD",
]);
const ZERO_DECIMAL = new Set(["JPY"]);

const PRICE_RE =
  /(?:(USD|EUR|GBP|CAD|AUD|CHF|JPY|INR|SEK|NOK|DKK|NZD)\s?|([$€£¥₹]))\s?(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?)(?:\s?(USD|EUR|GBP|CAD|AUD|CHF|JPY|INR|SEK|NOK|DKK|NZD))?/g;

/** Every money amount in `text`, in order, with its position. */
export function findPrices(text: string): (Money & { index: number; length: number })[] {
  const out: (Money & { index: number; length: number })[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const code = (m[1] ?? m[4] ?? SYMBOLS[m[2] ?? ""] ?? "").toUpperCase();
    if (!CODES.has(code)) continue;
    const money = parseAmount(m[3] ?? "", code, m[0].trim());
    if (money === undefined) continue;
    out.push({ ...money, index: m.index, length: m[0].length });
  }
  return out;
}

export function parseAmount(raw: string, currency: string, display = raw): Money | undefined {
  let digits = raw;
  // `1.234,56` (comma decimal) vs `1,234.56` (dot decimal): the last separator is the decimal one.
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const decimalSep = lastDot > lastComma ? "." : lastComma >= 0 ? "," : undefined;
  if (decimalSep !== undefined) {
    const [intPart, frac = ""] = raw.split(decimalSep === "." ? /\.(?=\d{1,2}$)/ : /,(?=\d{1,2}$)/);
    if (frac === "" && raw.split(decimalSep).length > 1) {
      // The separator was a thousands separator (e.g. 1,234): drop it.
      digits = raw.replace(/[.,]/g, "");
    } else {
      digits = `${(intPart ?? "").replace(/[.,]/g, "")}.${frac}`;
    }
  }
  const value = Number(digits);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const minor = ZERO_DECIMAL.has(currency) ? Math.round(value) : Math.round(value * 100);
  return { amountMinor: minor, currency, display };
}

export function formatMoney(m: Money): string {
  if (ZERO_DECIMAL.has(m.currency)) return `${m.amountMinor} ${m.currency}`;
  return `${(m.amountMinor / 100).toFixed(2)} ${m.currency}`;
}

export interface Offer {
  name: string;
  price: Money;
  /** The `Add to cart` control for this offer, when the page has one per offer. */
  addToCartRef?: string;
}

const ADD_TO_CART = /add to (cart|bag|basket)|buy now/i;
const CHECKOUT =
  /place order|checkout|check out|pay now|buy now|complete purchase|proceed to payment/i;
const NOISE =
  /^(total|subtotal|sub-total|shipping|tax|vat|discount|estimated|price|sale|was|from)\b[:\s]*$|^(free\s+)?(shipping|delivery|returns?)\b|\b(over|under|from|starting at|up to|save)$/i;

function cleanName(s: string): string {
  return s
    .replace(/[\s:–—-]+$/g, "")
    .replace(/^[\s:•*-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Lines that carry exactly one price become offers; `Add to cart` refs pair up in order. */
export function parseOffers(text: string, refs: SnapshotRef[]): Offer[] {
  const offers: Offer[] = [];
  for (const line of text.split(/\r?\n|(?<=[.!?])\s{2,}/)) {
    const prices = findPrices(line);
    if (prices.length !== 1) continue;
    const p = prices[0] as NonNullable<(typeof prices)[0]>;
    const name = cleanName(line.slice(0, p.index));
    if (name === "" || NOISE.test(name)) continue;
    offers.push({
      name,
      price: { amountMinor: p.amountMinor, currency: p.currency, display: p.display },
    });
  }
  const buttons = refs.filter((r) => ADD_TO_CART.test(r.name) && /button|link/i.test(r.role));
  if (buttons.length === offers.length) {
    offers.forEach((o, i) => {
      const b = buttons[i];
      if (b !== undefined) o.addToCartRef = b.ref;
    });
  }
  return offers;
}

export interface CartItem {
  name: string;
  qty: number;
  unitPrice: Money;
}

export interface Cart {
  seller?: string;
  items: CartItem[];
  total?: Money;
  currency?: string;
  /** The checkout control; the helpers never click it. */
  checkoutRef?: string;
}

/**
 * A cart page: `Seller: X`, item lines with a price (and `Qty N` / `x N` / a bare number column),
 * `Total: price`. Subtotal, tax and shipping lines are skipped.
 */
export function parseCart(text: string, refs: SnapshotRef[]): Cart {
  const cart: Cart = { items: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s*\|\s*/g, " | ").trim();
    if (line === "") continue;
    const seller = /^seller\s*:\s*(.+)$/i.exec(line);
    if (seller !== null) {
      cart.seller = cleanName(seller[1] ?? "");
      continue;
    }
    const prices = findPrices(line);
    if (prices.length === 0) continue;
    const last = prices[prices.length - 1] as NonNullable<(typeof prices)[0]>;
    const money: Money = {
      amountMinor: last.amountMinor,
      currency: last.currency,
      display: last.display,
    };
    const label = line.slice(0, (prices[0] as NonNullable<(typeof prices)[0]>).index);
    if (/^\s*(grand\s+)?total\b/i.test(label)) {
      cart.total = money;
      cart.currency = money.currency;
      continue;
    }
    if (/^\s*(subtotal|sub-total|shipping|delivery|tax|vat|discount|estimated)\b/i.test(label))
      continue;
    const qtyMatch = /(?:qty|quantity)\s*[:x]?\s*(\d+)|\bx\s?(\d+)\b|\|\s*(\d+)\s*\|/i.exec(label);
    const qty = Number(qtyMatch?.[1] ?? qtyMatch?.[2] ?? qtyMatch?.[3] ?? 1);
    const name = cleanName(
      label.replace(/\|.*$/, "").replace(/(?:qty|quantity)\s*[:x]?\s*\d+|\bx\s?\d+\b/i, ""),
    );
    if (name === "" || NOISE.test(name)) continue;
    cart.items.push({ name, qty: Number.isInteger(qty) && qty > 0 ? qty : 1, unitPrice: money });
  }
  if (cart.total === undefined && cart.items.length > 0) {
    const currency = cart.items[0]?.unitPrice.currency ?? "USD";
    const sum = cart.items.reduce((n, i) => n + i.qty * i.unitPrice.amountMinor, 0);
    cart.total = {
      amountMinor: sum,
      currency,
      display: formatMoney({ amountMinor: sum, currency, display: "" }),
    };
    cart.currency = currency;
  }
  const checkout = refs.find((r) => CHECKOUT.test(r.name) && /button|link/i.test(r.role));
  if (checkout !== undefined) cart.checkoutRef = checkout.ref;
  return cart;
}

// --- order emails (schema.org Order) ---------------------------------------------------------

export interface ParsedOrder {
  orderNumber?: string;
  status?: string;
  merchant?: string;
  orderDate?: string;
  items: { name: string; qty: number; price?: Money }[];
  total?: Money;
  tracking?: { carrier?: string; number?: string; url?: string; expected?: string }[];
  source: "json-ld" | "text";
}

function statusWord(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /Order(\w+)$/.exec(v);
  return (m?.[1] ?? v).toLowerCase();
}

function moneyOf(price: unknown, currency: unknown): Money | undefined {
  if (price === undefined || price === null) return undefined;
  const raw = typeof price === "number" ? price.toFixed(2) : String(price);
  const code =
    typeof currency === "string" && CODES.has(currency.toUpperCase())
      ? currency.toUpperCase()
      : "USD";
  return parseAmount(raw.replace(/[^\d.,]/g, ""), code, `${raw} ${code}`);
}

function orderFromJsonLd(node: Record<string, unknown>): ParsedOrder | undefined {
  const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  if (!type.includes("Order")) return undefined;
  const order: ParsedOrder = { items: [], source: "json-ld" };
  if (typeof node.orderNumber === "string") order.orderNumber = node.orderNumber.slice(0, 100);
  const status = statusWord(node.orderStatus);
  if (status !== undefined) order.status = status;
  const merchant = node.merchant ?? node.seller;
  if (
    typeof merchant === "object" &&
    merchant !== null &&
    typeof (merchant as { name?: unknown }).name === "string"
  ) {
    order.merchant = String((merchant as { name: string }).name).slice(0, 200);
  }
  if (typeof node.orderDate === "string") order.orderDate = node.orderDate;
  const offers = Array.isArray(node.acceptedOffer)
    ? node.acceptedOffer
    : node.acceptedOffer === undefined
      ? []
      : [node.acceptedOffer];
  for (const o of offers) {
    if (typeof o !== "object" || o === null) continue;
    const offer = o as Record<string, unknown>;
    const item = offer.itemOffered as { name?: unknown } | undefined;
    const qty = offer.eligibleQuantity as { value?: unknown } | undefined;
    const price = moneyOf(offer.price, offer.priceCurrency);
    order.items.push({
      name: String(item?.name ?? "item").slice(0, 200),
      qty: typeof qty?.value === "number" ? qty.value : 1,
      ...(price === undefined ? {} : { price }),
    });
  }
  const total = moneyOf(node.totalPrice ?? node.price, node.priceCurrency);
  if (total !== undefined) order.total = total;
  const deliveries = Array.isArray(node.orderDelivery)
    ? node.orderDelivery
    : node.orderDelivery === undefined
      ? []
      : [node.orderDelivery];
  const tracking = deliveries
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
    .map((d) => {
      const t: NonNullable<ParsedOrder["tracking"]>[number] = {};
      const carrier = d.carrier as { name?: unknown } | undefined;
      if (typeof carrier?.name === "string") t.carrier = carrier.name.slice(0, 100);
      if (typeof d.trackingNumber === "string") t.number = d.trackingNumber.slice(0, 100);
      if (typeof d.trackingUrl === "string" && /^https:\/\//i.test(d.trackingUrl))
        t.url = d.trackingUrl.slice(0, 500);
      const expected = d.expectedArrivalUntil ?? d.expectedArrivalFrom;
      if (typeof expected === "string") t.expected = expected;
      return t;
    });
  if (tracking.length > 0) order.tracking = tracking;
  return order;
}

/** `Order` objects from JSON-LD blocks (or a plain JSON document); falls back to text heuristics. */
export function parseOrderEmail(input: { html?: string; text?: string }): ParsedOrder[] {
  const orders: ParsedOrder[] = [];
  const html = input.html ?? "";
  const blocks: string[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    blocks.push(m[1] ?? "");
  }
  if (blocks.length === 0 && input.text !== undefined && /^\s*[[{]/.test(input.text))
    blocks.push(input.text);
  for (const block of blocks) {
    let doc: unknown;
    try {
      doc = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(doc)
      ? doc
      : typeof doc === "object" &&
          doc !== null &&
          Array.isArray((doc as { "@graph"?: unknown })["@graph"])
        ? (doc as { "@graph": unknown[] })["@graph"]
        : [doc];
    for (const n of nodes) {
      if (typeof n !== "object" || n === null) continue;
      const o = orderFromJsonLd(n as Record<string, unknown>);
      if (o !== undefined) orders.push(o);
    }
  }
  if (orders.length > 0) return orders;
  const text = (input.text ?? html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const number = /order\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9-]{4,40})/i.exec(text)?.[1];
  const tracking = /tracking\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z0-9]{8,40})/i.exec(text)?.[1];
  const total = findPrices(text).find((p) =>
    /total/i.test(text.slice(Math.max(0, p.index - 20), p.index)),
  );
  if (number === undefined && tracking === undefined && total === undefined) return [];
  const order: ParsedOrder = { items: [], source: "text" };
  if (number !== undefined) order.orderNumber = number;
  if (tracking !== undefined) order.tracking = [{ number: tracking }];
  if (total !== undefined)
    order.total = {
      amountMinor: total.amountMinor,
      currency: total.currency,
      display: total.display,
    };
  return [order];
}
