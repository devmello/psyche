import { type BrowserDriver, PsycheError, type ToolCallDescription } from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../framework/binding.ts";
import { asObject, optString, reqString, schema, strArray } from "../framework/params.ts";
import type {
  CatalogueEntry,
  ConnectInput,
  Connector,
  ConnectorAction,
  ConnectorContext,
  ConnectorFactory,
  ConnectorHealth,
  ConnectorRecord,
  ConnectorTool,
  ConnectResult,
  ToolOutput,
} from "../framework/types.ts";
import {
  type Cart,
  formatMoney,
  type Money,
  type Offer,
  parseCart,
  parseOffers,
  parseOrderEmail,
} from "./parse.ts";

/**
 * Shopping helpers (feature M10, scenario V3) over the `BrowserDriver` contract: compare prices
 * across the owner's allowlisted merchants, add an offer to a cart, read the cart back, and stop
 * at the checkout hand-off. The hand-off is a `financial` tool with a `purchase` binding (merchant,
 * amount in minor units, currency, line-item hash, security §3.5): the owner's card shows seller,
 * items and total, and the executor re-reads the cart and refuses when it no longer matches.
 * Nothing here submits a checkout form or enters payment details; payment is Stripe Link (G12),
 * a later milestone. Order tracking parses schema.org `Order` data out of order emails.
 */

export interface Merchant {
  id: string;
  name: string;
  /** `https://shop.example` */
  origin: string;
  /** Path with `{q}` for the query, e.g. `/search?q={q}`. */
  searchPath: string;
  /** Default `/cart`. */
  cartPath: string;
}

export const SHOPPING_ACTIONS: ConnectorAction[] = [
  {
    id: "shop.search",
    title: "Search and compare prices",
    sideEffect: "read",
    defaultRule: "allow",
  },
  {
    id: "shop.cart",
    title: "Add items to a cart",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
  {
    id: "shop.checkout",
    title: "Hand off a cart to checkout",
    sideEffect: "financial",
    approvalKind: "purchase",
    defaultRule: "ask",
  },
  { id: "shop.orders", title: "Read order emails", sideEffect: "none", defaultRule: "allow" },
];

export const SHOPPING_CATALOGUE: CatalogueEntry = {
  type: "shopping",
  id: "shopping",
  label: "Shopping",
  description:
    "Compare prices across the stores you allow, build a cart and hand it off for checkout.",
  category: "first_party",
  vendor: "Psyche",
  auth: "none",
  scopes: { read: ["shop.read"], read_act: ["shop.read", "shop.cart"] },
  actions: SHOPPING_ACTIONS,
  setupGuide: "packages/connectors/README.md#shopping-helpers-m10",
  available: true,
};

const MERCHANT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseMerchants(config: Record<string, unknown>): Merchant[] {
  if (!Array.isArray(config.merchants) || config.merchants.length === 0) {
    throw new PsycheError("invalid_params", "config.merchants must list at least one store");
  }
  if (config.merchants.length > 20) throw new PsycheError("invalid_params", "at most 20 merchants");
  const out: Merchant[] = [];
  for (const raw of config.merchants) {
    const m = asObject(raw);
    const id = reqString(m.id, "merchant.id");
    if (!MERCHANT_ID.test(id))
      throw new PsycheError("invalid_params", `merchant id ${id} is invalid`);
    let origin: URL;
    try {
      origin = new URL(reqString(m.origin, "merchant.origin"));
    } catch {
      throw new PsycheError("invalid_params", `merchant ${id}: origin must be a URL`);
    }
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.username !== ""
    ) {
      throw new PsycheError("invalid_params", `merchant ${id}: origin must be a bare https origin`);
    }
    const searchPath = reqString(m.searchPath, "merchant.searchPath");
    if (!searchPath.startsWith("/") || !searchPath.includes("{q}")) {
      throw new PsycheError(
        "invalid_params",
        `merchant ${id}: searchPath must start with / and contain {q}`,
      );
    }
    const cartPath = typeof m.cartPath === "string" ? m.cartPath : "/cart";
    if (!cartPath.startsWith("/"))
      throw new PsycheError("invalid_params", `merchant ${id}: cartPath must start with /`);
    if (out.some((x) => x.id === id))
      throw new PsycheError("invalid_params", `duplicate merchant ${id}`);
    out.push({
      id,
      name: typeof m.name === "string" && m.name !== "" ? m.name.slice(0, 100) : id,
      origin: origin.origin,
      searchPath,
      cartPath,
    });
  }
  return out;
}

export interface ShoppingFactoryOptions {
  browser: BrowserDriver;
  /** Browser profile for storefront sessions; default the driver's first profile. */
  profileId?: string;
}

interface LineItem {
  name: string;
  qty: number;
  unitPriceMinor: number;
}

interface HandoffParams {
  merchant: string;
  currency: string;
  items: LineItem[];
  totalMinor: number;
}

function handoffParams(params: unknown): HandoffParams {
  const p = asObject(params);
  const currency = reqString(p.currency, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new PsycheError("invalid_params", "currency must be ISO 4217");
  if (!Array.isArray(p.items) || p.items.length === 0)
    throw new PsycheError("invalid_params", "items are required");
  const items = p.items.map((raw): LineItem => {
    const i = asObject(raw);
    const qty = typeof i.qty === "number" ? i.qty : 1;
    const unit = i.unitPriceMinor;
    if (
      !Number.isInteger(qty) ||
      qty < 1 ||
      typeof unit !== "number" ||
      !Number.isInteger(unit) ||
      unit < 0
    ) {
      throw new PsycheError("invalid_params", "items need an integer qty and unitPriceMinor");
    }
    return { name: reqString(i.name, "item.name").slice(0, 200), qty, unitPriceMinor: unit };
  });
  if (typeof p.totalMinor !== "number" || !Number.isInteger(p.totalMinor) || p.totalMinor < 1) {
    throw new PsycheError("invalid_params", "totalMinor must be a positive integer");
  }
  return { merchant: reqString(p.merchant, "merchant"), currency, items, totalMinor: p.totalMinor };
}

const sortedItems = (items: LineItem[]) =>
  [...items].sort((a, b) => (canonicalJSON(a) < canonicalJSON(b) ? -1 : 1));

/**
 * Security §3.5 `purchase`: merchant host, amount in minor units, currency, line-item hash
 * (sorted `{name, qty, unitPrice}`), payment source (`none`: the hand-off pays nothing). No grant
 * key: `financial` is `once` only.
 */
export function purchaseBinding(merchant: Merchant, params: unknown): ToolCallDescription {
  const p = handoffParams(params);
  const lineItems = sortedItems(p.items).map((i) => ({
    name: i.name,
    qty: i.qty,
    unitPrice: i.unitPriceMinor,
  }));
  const total: Money = { amountMinor: p.totalMinor, currency: p.currency, display: "" };
  return {
    kind: "purchase",
    sideEffect: "financial",
    target: { kind: "origin", value: merchant.origin, display: merchant.name },
    bindingFields: {
      merchant: new URL(merchant.origin).host,
      amount: formatMoney(total),
      amountMinor: p.totalMinor,
      currency: p.currency,
      lineItems: lineItems.map(
        (i) =>
          `${i.qty} × ${i.name} @ ${formatMoney({ amountMinor: i.unitPrice, currency: p.currency, display: "" })}`,
      ),
      lineItemsSha256: sha256(canonicalJSON(lineItems)),
      paymentSourceId: "none",
    },
    summary: `Check out ${p.items.reduce((n, i) => n + i.qty, 0)} item(s) at ${merchant.name} for ${formatMoney(total)} (hand-off only, no payment yet)`,
  };
}

/** Add to cart: connector id, merchant, offer name and unit price. */
export function cartBinding(
  connectorId: string,
  merchant: Merchant,
  params: unknown,
): ToolCallDescription {
  const p = asObject(params);
  return {
    kind: "connector_action",
    target: { kind: "origin", value: merchant.origin, display: merchant.name },
    bindingFields: {
      connectorId,
      tool: "shop_add_to_cart",
      merchant: merchant.id,
      paramsHash: sha256(canonicalJSON(params ?? {})),
    },
    grantKey: `connector_action:${connectorId}:shop_add_to_cart:${merchant.id}`,
    summary: `Add "${String(p.offerName ?? "").slice(0, 60)}" to the cart at ${merchant.name}`,
  };
}

export class ShoppingConnector implements Connector {
  readonly id: string;
  readonly type = "shopping";
  readonly #ctx: ConnectorContext;
  readonly #browser: BrowserDriver;
  readonly #profileId: string | undefined;
  #merchants: Merchant[];
  #status: ConnectorRecord["status"];

  constructor(record: ConnectorRecord, ctx: ConnectorContext, options: ShoppingFactoryOptions) {
    this.id = record.id;
    this.#ctx = ctx;
    this.#browser = options.browser;
    this.#profileId = options.profileId;
    this.#merchants = parseMerchants(record.config as Record<string, unknown>);
    this.#status = record.status;
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    this.#merchants = parseMerchants(input.config as Record<string, unknown>);
    this.#status = "connected";
    return {
      account: null,
      scopes: SHOPPING_CATALOGUE.scopes[input.scopeMode],
      config: { merchants: this.#merchants as unknown as ConnectInput["config"][string] },
    };
  }

  async disconnect(): Promise<void> {
    this.#status = "disconnected";
  }

  actions(): ConnectorAction[] {
    return SHOPPING_ACTIONS;
  }

  async health(): Promise<ConnectorHealth> {
    return {
      ok: this.#status === "connected",
      status: this.#status,
      checkedAt: this.#ctx.clock.now(),
    };
  }

  merchants(): Merchant[] {
    return this.#merchants.map((m) => ({ ...m }));
  }

  /** A merchant by id or by its exact origin. */
  #merchant(id: unknown): Merchant {
    const m = this.#merchants.find((x) => x.id === id || x.origin === id);
    if (m === undefined) {
      throw new PsycheError("policy_denied", `${String(id)} is not one of the allowlisted stores`);
    }
    return m;
  }

  /** One clean browser session per call, closed afterwards. */
  async #withTab<T>(
    url: string,
    signal: AbortSignal,
    fn: (tabId: string) => Promise<T>,
  ): Promise<T> {
    const session = await this.#browser.openSession({
      partition: "clean",
      ...(this.#profileId === undefined ? {} : { profileId: this.#profileId }),
    });
    try {
      const tab = await this.#browser.openTab(session.id);
      await this.#browser.navigate(tab.id, url, { signal });
      return await fn(tab.id);
    } finally {
      await this.#browser.closeSession(session.id).catch(() => undefined);
    }
  }

  async #page(tabId: string) {
    const [text, snap] = await Promise.all([
      this.#browser.readText(tabId, { maxChars: 200_000 }),
      this.#browser.snapshot(tabId, { maxRefs: 500 }),
    ]);
    return { text: text.text, refs: snap.refs, url: snap.url, title: snap.title };
  }

  #searchUrl(m: Merchant, query: string): string {
    return `${m.origin}${m.searchPath.replace("{q}", encodeURIComponent(query))}`;
  }

  async #search(m: Merchant, query: string, signal: AbortSignal) {
    return this.#withTab(this.#searchUrl(m, query), signal, async (tabId) => {
      const page = await this.#page(tabId);
      return { url: page.url, title: page.title, offers: parseOffers(page.text, page.refs) };
    });
  }

  async #readCart(tabId: string): Promise<Cart> {
    const page = await this.#page(tabId);
    return parseCart(page.text, page.refs);
  }

  tools(): ConnectorTool[] {
    const untrusted = (output: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
      output,
      provenance: "untrusted",
      ...extra,
    });
    const merchantView = (m: Merchant) => ({ id: m.id, name: m.name, origin: m.origin });
    const offerView = (o: Offer) => ({
      name: o.name,
      price: o.price,
      priceDisplay: formatMoney(o.price),
    });
    return [
      {
        name: "shop_list_merchants",
        action: "shop.search",
        description: "The stores the owner allows shopping at.",
        inputSchema: schema.obj({}),
        sideEffect: "none",
        execute: async () => ({ output: this.#merchants.map(merchantView), provenance: "trusted" }),
      },
      {
        name: "shop_search",
        action: "shop.search",
        description: "Search one allowlisted store for an item; returns offers with prices.",
        inputSchema: schema.obj({ merchant: schema.str, query: schema.str }, ["merchant", "query"]),
        sideEffect: "read",
        execute: async (p, run) => {
          const o = asObject(p);
          const m = this.#merchant(o.merchant);
          const r = await this.#search(m, reqString(o.query, "query").slice(0, 200), run.signal);
          return untrusted({
            merchant: merchantView(m),
            url: r.url,
            offers: r.offers.map(offerView),
          });
        },
      },
      {
        name: "shop_compare",
        action: "shop.search",
        description:
          "Search every allowlisted store (or the given ones) and rank the offers by price.",
        inputSchema: schema.obj({ query: schema.str, merchants: schema.strs }, ["query"]),
        sideEffect: "read",
        execute: async (p, run) => {
          const o = asObject(p);
          const query = reqString(o.query, "query").slice(0, 200);
          const ids = strArray(o.merchants, "merchants");
          const targets = ids.length === 0 ? this.#merchants : ids.map((id) => this.#merchant(id));
          const offers: (ReturnType<typeof offerView> & {
            merchant: string;
            merchantName: string;
          })[] = [];
          const failures: { merchant: string; error: string }[] = [];
          for (const m of targets) {
            try {
              const r = await this.#search(m, query, run.signal);
              for (const of of r.offers)
                offers.push({ ...offerView(of), merchant: m.id, merchantName: m.name });
            } catch (err) {
              failures.push({ merchant: m.id, error: PsycheError.from(err).code });
            }
          }
          offers.sort(
            (a, b) =>
              a.price.amountMinor - b.price.amountMinor || a.merchant.localeCompare(b.merchant),
          );
          return untrusted({ query, offers, cheapest: offers[0] ?? null, failures });
        },
      },
      {
        name: "shop_view_cart",
        action: "shop.search",
        description: "Read the current cart at one store: seller, items, total.",
        inputSchema: schema.obj({ merchant: schema.str }, ["merchant"]),
        sideEffect: "read",
        execute: async (p, run) => {
          const m = this.#merchant(asObject(p).merchant);
          const cart = await this.#withTab(`${m.origin}${m.cartPath}`, run.signal, (tab) =>
            this.#readCart(tab),
          );
          return untrusted({ merchant: merchantView(m), cart: cartView(cart) });
        },
      },
      {
        name: "shop_add_to_cart",
        action: "shop.cart",
        description:
          "Search a store and add the named offer to its cart (one unit). Returns the cart.",
        inputSchema: schema.obj(
          { merchant: schema.str, query: schema.str, offerName: schema.str },
          ["merchant", "query", "offerName"],
        ),
        sideEffect: "write",
        describeCall: (p) => cartBinding(this.id, this.#merchant(asObject(p).merchant), p),
        execute: async (p, run) => {
          const o = asObject(p);
          const m = this.#merchant(o.merchant);
          const query = reqString(o.query, "query").slice(0, 200);
          const wanted = reqString(o.offerName, "offerName").toLowerCase();
          const cart = await this.#withTab(this.#searchUrl(m, query), run.signal, async (tabId) => {
            const page = await this.#page(tabId);
            const offers = parseOffers(page.text, page.refs);
            const offer =
              offers.find((x) => x.name.toLowerCase() === wanted) ??
              offers.find((x) => x.name.toLowerCase().includes(wanted));
            if (offer === undefined)
              throw new PsycheError(
                "not_found",
                `no offer named "${wanted.slice(0, 60)}" at ${m.name}`,
              );
            if (offer.addToCartRef === undefined)
              throw new PsycheError(
                "unavailable",
                `no "Add to cart" control for "${offer.name.slice(0, 60)}"`,
              );
            await this.#browser.click(tabId, offer.addToCartRef);
            const after = await this.#browser.snapshot(tabId, { maxRefs: 1 });
            if (new URL(after.url).pathname !== m.cartPath)
              await this.#browser.navigate(tabId, `${m.origin}${m.cartPath}`, {
                signal: run.signal,
              });
            return { offer, cart: await this.#readCart(tabId) };
          });
          return untrusted(
            { merchant: merchantView(m), added: offerView(cart.offer), cart: cartView(cart.cart) },
            {
              externalRefs: { merchant: m.id },
              receiptSummary: `Added "${cart.offer.name.slice(0, 60)}" (${formatMoney(cart.offer.price)}) to the cart at ${m.name}`,
            },
          );
        },
      },
      {
        name: "shop_checkout_handoff",
        action: "shop.checkout",
        description:
          "Hand a cart off for checkout: the owner approves seller, items and total; the cart is re-read and must match. Nothing is paid or ordered here (payment is a later step).",
        inputSchema: schema.obj(
          {
            merchant: schema.str,
            currency: schema.str,
            items: {
              type: "array",
              maxItems: 100,
              items: schema.obj(
                {
                  name: schema.str,
                  qty: schema.int(1, 999),
                  unitPriceMinor: schema.int(0, 100_000_000),
                },
                ["name", "unitPriceMinor"],
              ),
            },
            totalMinor: schema.int(1, 1_000_000_000),
          },
          ["merchant", "currency", "items", "totalMinor"],
        ),
        sideEffect: "financial",
        describeCall: (p) => purchaseBinding(this.#merchant(asObject(p).merchant), p),
        execute: async (p, run) => {
          const params = handoffParams(p);
          const m = this.#merchant(params.merchant);
          const cart = await this.#withTab(`${m.origin}${m.cartPath}`, run.signal, (tab) =>
            this.#readCart(tab),
          );
          const live = sortedItems(
            cart.items.map((i) => ({
              name: i.name,
              qty: i.qty,
              unitPriceMinor: i.unitPrice.amountMinor,
            })),
          );
          const approved = sortedItems(params.items);
          const total = cart.total;
          if (
            total === undefined ||
            total.currency !== params.currency ||
            total.amountMinor !== params.totalMinor ||
            canonicalJSON(live) !== canonicalJSON(approved)
          ) {
            throw new PsycheError(
              "conflict",
              "the cart no longer matches what was approved; review it and ask again",
              {
                details: { cart: cartView(cart) },
              },
            );
          }
          const totalDisplay = formatMoney(total);
          return untrusted(
            {
              status: "handoff_ready",
              seller: cart.seller ?? m.name,
              merchant: merchantView(m),
              items: cart.items.map((i) => ({
                name: i.name,
                qty: i.qty,
                unitPrice: formatMoney(i.unitPrice),
              })),
              total: totalDisplay,
              currency: total.currency,
              checkoutUrl: `${m.origin}${m.cartPath}`,
              payment: "not_configured",
              note: "No payment was made and no order was placed. Paying needs Stripe Link (G12), which is not set up yet.",
            },
            {
              externalRefs: { merchant: m.id, total: totalDisplay },
              receiptSummary: `Checkout hand-off ready at ${cart.seller ?? m.name}: ${totalDisplay} for ${cart.items.length} item(s); nothing paid`,
            },
          );
        },
      },
      {
        name: "shop_parse_order_email",
        action: "shop.orders",
        description:
          "Extract order number, status, items, total and tracking from an order email (schema.org Order when present).",
        inputSchema: schema.obj({ html: schema.str, text: schema.str }),
        sideEffect: "none",
        execute: async (p) => {
          const o = asObject(p ?? {});
          const html = optString(o.html);
          const text = optString(o.text);
          if (html === undefined && text === undefined)
            throw new PsycheError("invalid_params", "html or text is required");
          if ((html?.length ?? 0) + (text?.length ?? 0) > 2_000_000)
            throw new PsycheError("invalid_params", "email too large");
          return untrusted({
            orders: parseOrderEmail({
              ...(html === undefined ? {} : { html }),
              ...(text === undefined ? {} : { text }),
            }),
          });
        },
      },
    ];
  }
}

function cartView(cart: Cart) {
  return {
    seller: cart.seller ?? null,
    items: cart.items.map((i) => ({
      name: i.name,
      qty: i.qty,
      unitPriceMinor: i.unitPrice.amountMinor,
      unitPrice: formatMoney(i.unitPrice),
    })),
    total: cart.total === undefined ? null : formatMoney(cart.total),
    totalMinor: cart.total?.amountMinor ?? null,
    currency: cart.currency ?? null,
    hasCheckout: cart.checkoutRef !== undefined,
  };
}

export function shoppingFactory(options: ShoppingFactoryOptions): ConnectorFactory {
  return {
    entry: SHOPPING_CATALOGUE,
    create: (record, ctx) => new ShoppingConnector(record, ctx, options),
  };
}
