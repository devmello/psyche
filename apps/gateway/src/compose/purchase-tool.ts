import {
  type BrowserDriverEx,
  type ElementMeta,
  type OrderSummary,
  parseMoney,
  readOrder,
} from "@psyche/browser";
import {
  type ApprovalRequest,
  PsycheError,
  type ToolCallDescription,
  type ToolRegistration,
} from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import {
  FINANCIAL_BLOCK_REASON,
  financialBlock,
  isNoCheckoutVenue,
} from "@psyche/protocol/financial-block";
import {
  type CardField,
  cardFieldAccepts,
  formatAmount,
  type PaymentBroker,
  type PurchaseInput,
  type SecretRedactor,
} from "@psyche/vault";
import type { CallContexts } from "./call-context.ts";

/**
 * `checkout.pay_with_link`: the agent pays for the checkout open in one of its browser tabs with
 * Stripe Link's one-time card (feature G12). Money moves only through this path:
 *
 * 1. The loop describes the call from the tab (origin from the tab, merchant / items / total as
 *    the page shows them) and asks the owner on a device-only `purchase` card, `once`.
 * 2. After the tap the tool re-reads the checkout and refuses unless the order is exactly what
 *    the card bound (`order_changed`, `origin_changed`), then has the `PaymentBroker` create the
 *    Link spend request, wait for the owner's approval in Link and write the card to a 0600 file.
 * 3. Card fields are typed by the browser's `fillSecret` from handles the broker makes after its
 *    own origin / frame / field checks. Values never reach this module as strings, the model, the
 *    transcript, logs, audit or the receipt: only brand and last4 do.
 * 4. The order is submitted and the page's answer decides the receipt: paid, declined or
 *    unconfirmed (cancelled in Link, nothing recorded as captured).
 */

export const PURCHASE_TOOL = "checkout.pay_with_link";
/** What a Stripe Link Pay card names as its source (`details.paymentSource`). */
export const LINK_PAYMENT_SOURCE = "Stripe Link (one-time card)";

export interface PurchaseToolDeps {
  payments: PaymentBroker;
  /** The connected desktop's browser driver, or undefined while none is connected. */
  driver: () => BrowserDriverEx | undefined;
  /**
   * Why this Host cannot pay in the browser at all right now, if so (a headless Host has no
   * checkout driver yet, B3): the call is refused before any card is raised, and again when it
   * runs.
   */
  unavailable?: () => PsycheError | undefined;
  /** Throws unless `tabId` is one of the calling task's tabs. */
  ownsTab: (callId: string, tabId: string) => Promise<void>;
  calls: CallContexts;
  /** The Permission Broker's `get`, to re-check the approval this call runs under. */
  approvals: { get(id: string): Promise<ApprovalRequest | undefined> };
  redactor: SecretRedactor;
  /**
   * Whether Stripe Link can pay right now: a CLI connected and signed in. Checked when the call is
   * described and again when it runs, so a tool list built before a disconnect raises no Pay card.
   * Absent with a caller-supplied wallet, which is always ready.
   */
  ready?: () => boolean;
  /** Link test mode: test cards, no charge. */
  test?: boolean;
  /** How long to wait for the merchant's answer after submitting (default 20 s). */
  settleMs?: number;
}

const CARD_FIELDS: CardField[] = [
  "number",
  "exp",
  "exp_month",
  "exp_year",
  "cvc",
  "name",
  "postal",
];
const SUBMIT_NAME =
  /^(?:pay\b|pay now|place (?:your )?order|complete (?:order|purchase)|submit (?:order|payment)|buy now|confirm (?:order|payment))/i;
const DECLINED =
  /\b(?:declined|payment (?:failed|was unsuccessful)|card (?:was )?(?:rejected|not accepted))\b/i;
const CONFIRMED =
  /\b(?:thank you for your (?:order|purchase)|order (?:confirmed|placed|received|complete)|payment (?:successful|received))\b/i;
const ORDER_REF =
  /\b(?:order|confirmation)\s*(?:number|no\.?|id|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i;

const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, KWD: 3, BHD: 3 };

/** `12.50` + `USD` → 1250 minor units; undefined when it does not fit the currency's exponent. */
export function toMinor(amount: string, currency: string): number | undefined {
  const exp = EXPONENT[currency] ?? 2;
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(amount);
  if (m === null) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > exp)
    return /^0*$/.test(frac.slice(exp))
      ? toMinor(`${m[1]}.${frac.slice(0, exp)}`, currency)
      : undefined;
  const n = Number(`${m[1]}${frac.padEnd(exp, "0")}`);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The amount as the card shows it: the currency's own format, with the code spelled out for any
 * `$` currency (`US$120.00`, `CA$15.00`), so a dollar sign never stands for an unstated currency.
 */
export function showAmount(minor: number, currency: string): string {
  const f = formatAmount(minor, currency.toUpperCase());
  if (!f.startsWith("$")) return f;
  return `${currency.toUpperCase() === "USD" ? "US" : currency.toUpperCase()}${f}`;
}

/** The total as Link will charge it: minor units from the unambiguous printed amount, or undefined. */
export function moneyOf(order: OrderSummary): { minor: number; currency: string } | undefined {
  if (order.amount === undefined || order.currency === undefined) return undefined;
  const minor = toMinor(order.amount, order.currency);
  return minor === undefined ? undefined : { minor, currency: order.currency };
}

/**
 * What the card binds: the tab's origin, the minor-unit amount (not the page's string), currency,
 * the seller if the page names one, the items read and the source.
 */
export function purchaseFields(order: OrderSummary) {
  const money = moneyOf(order);
  return {
    merchantOrigin: order.merchantOrigin,
    amountMinor: money?.minor ?? null,
    currency: money?.currency ?? null,
    seller: order.seller ?? null,
    lineItemHash: order.lineItemHash,
    paymentSource: "stripe_link",
  };
}

function inputOf(order: OrderSummary, test: boolean): PurchaseInput {
  const money = moneyOf(order);
  if (money === undefined) {
    throw new PsycheError("conflict", "the checkout total could not be read; ask the owner", {
      details: { reason: "total_unreadable" },
    });
  }
  const priced = order.items.flatMap((i) => {
    const p = i.price === undefined ? {} : parseMoney(i.price);
    const unit =
      p.amount === undefined || p.currency !== money.currency
        ? undefined
        : toMinor(p.amount, money.currency);
    return unit === undefined ? [] : [{ name: i.name, quantity: 1, unitAmount: unit }];
  });
  const sum = priced.reduce((n, li) => n + li.unitAmount, 0);
  const lineItems =
    priced.length > 0 && sum <= money.minor
      ? priced
      : [{ name: "Order", quantity: 1, unitAmount: money.minor }];
  // The merchant is the tab's host, which is bound; the page's own name is never sent to Link.
  const host = new URL(order.merchantOrigin).host;
  return {
    merchantName: host,
    merchantUrl: order.merchantOrigin,
    amount: money.minor,
    currency: money.currency.toLowerCase(),
    lineItems,
    ...(test ? { test: true } : {}),
  };
}

function elementOf(meta: ElementMeta) {
  return {
    tagName: meta.tag.toLowerCase(),
    frameOrigin: meta.frameOrigin,
    ...(meta.inputType === undefined ? {} : { type: meta.inputType }),
    ...(meta.autocomplete === undefined ? {} : { autocomplete: meta.autocomplete.toLowerCase() }),
    ...(meta.contentEditable === true ? { contentEditable: true } : {}),
    ...(meta.fieldName === undefined ? {} : { fieldName: meta.fieldName }),
  };
}

interface Located {
  order: OrderSummary;
  fields: Partial<Record<CardField, string>>;
  submit: string | undefined;
  /** The pay button's name as the page shows it now. */
  submitName: string | undefined;
  /** The page's address in that snapshot (its path decides PayPal.Me from a checkout). */
  url: string | undefined;
}

/** The first pay button a snapshot's text names (`- button "Buy now" [ref=…]`). */
function submitNameIn(text: string): string | undefined {
  for (const m of text.matchAll(/^\s*- button "((?:[^"\\]|\\.)*)"/gm)) {
    const name = (m[1] ?? "").replace(/\\(.)/g, "$1").trim();
    if (SUBMIT_NAME.test(name)) return name;
  }
  return undefined;
}

/**
 * The hard block on trades and transfers (`@psyche/protocol/financial-block`) for this tool: the
 * pay button it will press, on the page it is on. A brokerage, an exchange, a P2P service or a
 * bank refuses the tool outright; elsewhere the button's own words decide ("Buy now" at a shop is
 * a purchase). Undefined when the payment may go ahead.
 */
function hardBlock(
  origin: string,
  liveUrl: string | undefined,
  snapUrl: string | undefined,
  submitName: string | undefined,
) {
  if ([origin, liveUrl, snapUrl].some((u) => u !== undefined && isNoCheckoutVenue(u)))
    return { matched: "venue" };
  // The tab's live address decides PayPal.Me from PayPal's checkout: without one, a venue is
  // unreadable and refused (a shop is not a venue, so it goes ahead).
  if (liveUrl === undefined) return financialBlock({ unreadable: true, origin });
  for (const pageUrl of [liveUrl, snapUrl]) {
    if (pageUrl === undefined) continue;
    const b = financialBlock({
      labels: submitName === undefined ? [] : [submitName],
      role: "button",
      submits: true,
      pageUrl,
      origin,
    });
    if (b !== undefined) return b;
  }
  return undefined;
}

/** One snapshot: the order as the page shows it, the card inputs and the pay button. */
async function locate(d: BrowserDriverEx, tabId: string, origin: string): Promise<Located> {
  const snap = await d.snapshot(tabId);
  const order = readOrder(snap.text, origin);
  const fields: Partial<Record<CardField, string>> = {};
  let submit: string | undefined;
  let submitName: string | undefined;
  for (const r of snap.refs.slice(0, 250)) {
    if (r.role === "button" && submit === undefined && SUBMIT_NAME.test(r.name.trim())) {
      submit = r.ref;
      submitName = r.name.trim();
      continue;
    }
    if (!["textbox", "spinbutton", "combobox", "searchbox"].includes(r.role)) continue;
    const meta = await d.describe(tabId, r.ref).catch(() => undefined);
    if (meta === undefined) continue;
    for (const f of CARD_FIELDS) {
      if (fields[f] === undefined && cardFieldAccepts(f, elementOf(meta)).ok) fields[f] = r.ref;
    }
  }
  return { order, fields, submit, submitName, url: snap.url };
}

/** Thrown while Stripe Link is not connected and signed in: no card is raised for it. */
const notReady = (): never => {
  throw new PsycheError(
    "unavailable",
    "Stripe Link is not connected and signed in; ask the owner to set it up in Settings",
    { details: { reason: "payments_not_ready" } },
  );
};

/** A headless Host's checkout: not built yet, so the tool says so before any card (B3 r1). */
export function checkoutNeedsDesktop(): PsycheError {
  return new PsycheError(
    "unavailable",
    "Paying in Psyche's browser needs the Psyche desktop app connected to this Host. On a headless Host checkout isn't supported yet, so nothing was paid and no approval was asked.",
    { details: { reason: "checkout_needs_desktop" } },
  );
}

export function createPurchaseTool(deps: PurchaseToolDeps): ToolRegistration {
  const describeCall = (params: unknown): ToolCallDescription => {
    if (deps.ready !== undefined && !deps.ready()) notReady();
    const refused = deps.unavailable?.();
    if (refused !== undefined) throw refused;
    const tabId = (params as { tabId?: unknown } | undefined)?.tabId;
    const d = deps.driver();
    const origin = typeof tabId === "string" ? d?.tabOrigin(tabId) : undefined;
    if (d === undefined || typeof tabId !== "string" || origin === undefined) {
      return { kind: "purchase", sideEffect: "financial", summary: "Pay with Stripe Link" };
    }
    const peek = d.peekSnapshot(tabId);
    const order = readOrder(peek?.text ?? "", origin);
    const host = new URL(origin).host;
    // What the hard block on trades and transfers reads (`prohibition:financial_transfer`): the
    // pay button this tool will press, on this page. On a brokerage, an exchange, a P2P service or
    // a bank the call is refused before any card is shown, whatever the button says.
    // The address is the tab's live one (a route change included), never only the last snapshot's:
    // with no live address the call is unreadable, which a venue refuses.
    const submitName = submitNameIn(peek?.text ?? "");
    const live = d.tabUrl(tabId);
    const pageUrl = live ?? origin;
    const control =
      live === undefined ||
      isNoCheckoutVenue(origin) ||
      isNoCheckoutVenue(live) ||
      (peek !== undefined && isNoCheckoutVenue(peek.url))
        ? { unreadable: true, pageUrl }
        : {
            labels: submitName === undefined ? [] : [submitName],
            role: "button",
            submits: true,
            pageUrl,
          };
    // The amount is the one Link will charge, in the currency's own format; the page's words
    // sit beside it. An unreadable total is shown as such and the tool will refuse it.
    const money = moneyOf(order);
    const said = order.totalText ?? order.total ?? "nothing";
    const total =
      money === undefined
        ? `an amount that could not be read (the page says ${said})`
        : `${showAmount(money.minor, money.currency)} (the page says ${said})`;
    const items = order.items.length === 0 ? "; items not checked on this page" : "";
    const seller =
      order.seller === undefined ? "" : ` (the page says the seller is "${order.seller}")`;
    return {
      kind: "purchase",
      sideEffect: "financial",
      target: { kind: "origin", value: origin },
      summary: `Pay ${total} to ${host}${seller} with Stripe Link (one-time card)${items}`,
      details: {
        merchant: host,
        merchantHost: host,
        total: money === undefined ? null : showAmount(money.minor, money.currency),
        pageTotal: order.total ?? null,
        itemsChecked: order.items.length > 0,
        lineItems: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
        paymentSource: LINK_PAYMENT_SOURCE,
        requiresAuthentication: true,
      },
      bindingFields: purchaseFields(order),
      grantKey: `purchase|${origin}`,
      meta: { control },
    };
  };
  const refuseTrade = (): never => {
    throw new PsycheError("policy_denied", FINANCIAL_BLOCK_REASON, {
      details: { rule: "prohibition:financial_transfer" },
    });
  };

  const refuse = (message: string, reason: string): never => {
    throw new PsycheError("policy_denied", message, { details: { reason } });
  };

  return {
    spec: {
      name: PURCHASE_TOOL,
      description:
        "Pay for the checkout open in a browser tab with the owner's Stripe Link one-time card. Open the checkout page and read it first (browser.snapshot) so the order is on screen. The owner approves the exact merchant, items and total on their device; you never see card details. One approval pays once: if the total or merchant changes, ask again. Returns the card's brand and last four and the order reference.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tabId"],
        properties: { tabId: { type: "string", minLength: 1, maxLength: 200 } },
      },
      sideEffect: "financial",
      targetKind: "origin",
      provenanceOut: "untrusted",
    },
    describeCall,
    async execute(callId, params) {
      const tabId = (params as { tabId?: unknown }).tabId;
      if (typeof tabId !== "string") throw new PsycheError("invalid_params", "tabId is required");
      if (deps.ready !== undefined && !deps.ready()) notReady();
      const refused = deps.unavailable?.();
      if (refused !== undefined) throw refused;
      const ctx = deps.calls.context(callId);
      const approvalId = ctx.approvalId;
      if (approvalId === undefined) {
        throw new PsycheError("approval_required", "paying needs the owner's purchase approval");
      }
      const d = deps.driver();
      if (d === undefined) throw new PsycheError("unavailable", "the browser is not connected");
      await deps.ownsTab(callId, tabId);
      const approval = await deps.approvals.get(approvalId);
      if (approval === undefined) throw new PsycheError("approval_required", "approval not found");
      const origin = () => d.tabOrigin(tabId);
      // Everything below is judged on a fresh read, never on what the model said or saw earlier.
      const check = (loc: Located): string => {
        const now = origin();
        if (now === undefined || now !== loc.order.merchantOrigin) {
          refuse("the checkout is not on the approved merchant's site", "origin_changed");
        }
        const hash = toolCallBindingHash(PURCHASE_TOOL, params, {
          kind: "purchase",
          bindingFields: purchaseFields(loc.order),
        });
        if (hash !== approval.bindingHash) {
          refuse("the checkout no longer matches what the owner approved", "order_changed");
        }
        return hash;
      };
      const start = origin();
      if (start === undefined) throw new PsycheError("conflict", "the tab has no page yet");
      const first = await locate(d, tabId, start);
      // The hard block, on the live page, before a spend request exists.
      if (hardBlock(start, d.tabUrl(tabId), first.url, first.submitName) !== undefined)
        refuseTrade();
      const hash = check(first);
      const input = inputOf(first.order, deps.test === true);
      for (const f of ["number", "cvc"] as const) {
        if (first.fields[f] === undefined) {
          refuse("the checkout page shows no card form to fill", "no_card_form");
        }
      }
      if (
        first.fields.exp === undefined &&
        (first.fields.exp_month === undefined || first.fields.exp_year === undefined)
      ) {
        refuse("the checkout page shows no card form to fill", "no_card_form");
      }
      if (first.submit === undefined)
        refuse("the checkout page shows no pay button", "no_pay_button");

      const spend = await deps.payments.authorizeDispatched(approvalId, input, hash);
      const id = spend.spendRequestId;
      let card: Awaited<ReturnType<PaymentBroker["awaitCard"]>>;
      try {
        card = await deps.payments.awaitCard(id);
      } catch (err) {
        await deps.payments.cancel(id).catch(() => undefined);
        throw err;
      }
      // From the first card field on, every input value of the checkout document is masked in
      // snapshots until that document goes away (a real navigation) or 2 h pass; it is not lifted
      // when the payment ends, because the model only reads the page after this tool returns.
      let submit = "";
      try {
        // The page may have moved while the owner approved in Link.
        const cur = await locate(d, tabId, origin() ?? start);
        check(cur);
        const order: Array<[CardField, string | undefined]> = (
          ["number", "exp", "exp_month", "exp_year", "cvc", "name", "postal"] as CardField[]
        ).map((f) => [f, cur.fields[f]]);
        for (const [field, ref] of order) {
          if (ref === undefined) continue;
          if (field === "exp" && cur.fields.exp === undefined) continue;
          const meta = await d.describe(tabId, ref);
          const el = elementOf(meta);
          const at = origin();
          if (at === undefined) refuse("the checkout page closed", "origin_changed");
          const secret = await deps.payments.cardSecret({
            spendRequestId: id,
            field,
            origin: at as string,
            element: el,
          });
          try {
            await d.fillSecret(
              tabId,
              ref,
              secret,
              at as string,
              (live) =>
                cardFieldAccepts(field, {
                  ...live,
                  ...(el.fieldName === undefined ? {} : { fieldName: el.fieldName }),
                }),
              { maskDocument: true },
            );
          } finally {
            secret.dispose();
          }
        }
        // Last look before the order is placed: same merchant, same order, same button.
        const last = await locate(d, tabId, origin() ?? start);
        check(last);
        if (last.submit === undefined)
          refuse("the checkout page shows no pay button", "no_pay_button");
        // Last look for the hard block too: the page may have moved to a venue, or the button
        // may now say something else. The spend request is cancelled below.
        const at = origin() ?? start;
        if (hardBlock(at, d.tabUrl(tabId), last.url, last.submitName) !== undefined) refuseTrade();
        submit = last.submit as string;
      } catch (err) {
        await deps.payments.cancel(id).catch(() => undefined);
        throw err;
      }
      const total = showAmount(input.amount, input.currency.toUpperCase());
      const paidWith = {
        method: "stripe_link",
        brand: card.card?.brand,
        last4: card.card?.last4,
      };
      // From the click on, money may move: every failure ends as `unconfirmed` (a receipt, the
      // Link request ended, the card shredded), never as nothing recorded.
      const unconfirmed = async () => {
        const receipt = await deps.payments
          .unconfirmed(id, { toolCallId: callId })
          .catch(() => undefined);
        if (receipt === undefined) await deps.payments.cancel(id).catch(() => undefined);
        return {
          output: {
            status: "unconfirmed",
            seller: input.merchantName,
            total,
            paidWith,
            linkSpendRequestId: id,
            note: "The order was submitted but the page did not confirm it, so it may have gone through. Do not pay again; tell the owner to check the merchant's order page or email.",
          },
          provenance: "untrusted" as const,
          ...(receipt === undefined ? {} : { receiptId: receipt.id }),
        };
      };
      // Driver calls throw synchronously for a closed tab; `call` turns that into a rejection.
      const call = <T>(f: () => Promise<T>): Promise<T> => Promise.resolve().then(f);
      let page = "";
      try {
        await call(() => d.click(tabId, submit));
        // The merchant's answer: poll up to settleMs for a confirmation or a decline.
        const deadline = Date.now() + (deps.settleMs ?? 20_000);
        for (;;) {
          const read = await call(() => d.readText(tabId));
          page = deps.redactor.redact(read.text).slice(0, 20_000);
          if (CONFIRMED.test(page) || DECLINED.test(page) || Date.now() >= deadline) break;
          const ms = Math.min(2000, Math.max(0, deadline - Date.now()));
          await call(() => d.wait(tabId, { kind: "timeout", ms }));
        }
      } catch {
        // The tab closed or the page stopped answering after the click.
        return unconfirmed();
      }
      if (DECLINED.test(page) && !CONFIRMED.test(page)) {
        const declined = await deps.payments
          .decline(id, { code: "card_declined", toolCallId: callId })
          .then(
            () => true,
            () => false,
          );
        // Only a payment still open can be unconfirmed; a recorded decline stands.
        if (!declined && deps.payments.get(id)?.payment.state === "none") return unconfirmed();
        throw new PsycheError(
          "unavailable",
          "the merchant declined the card; nothing was charged",
          { details: { reason: "payment_declined" } },
        );
      }
      if (!CONFIRMED.test(page)) return unconfirmed();
      const ref = ORDER_REF.exec(page)?.[1];
      const receipt = await deps.payments
        .complete(id, {
          outcome: "success",
          toolCallId: callId,
          ...(ref === undefined ? {} : { orderNumber: ref }),
        })
        .catch(() => undefined);
      if (receipt === undefined && deps.payments.get(id)?.payment.state === "none") {
        return unconfirmed();
      }
      return {
        output: {
          status: "paid",
          seller: input.merchantName,
          total,
          paidWith,
          ...(ref === undefined ? {} : { orderNumber: ref }),
          linkSpendRequestId: id,
          ...(deps.test === true ? { testMode: true } : {}),
        },
        provenance: "untrusted",
        ...(receipt === undefined ? {} : { receiptId: receipt.id }),
      };
    },
  };
}
