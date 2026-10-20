import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ApprovalRequestInput,
  type AuditLog,
  type Clock,
  type IssuedApproval,
  type JsonObject,
  type PermissionBroker,
  type Receipt,
  ResolvedSecret,
  type Surface,
} from "@psyche/protocol";
import { canonicalHost, strictCanonicalJSON } from "../binding.ts";
import { fail } from "../errors.ts";
import {
  type BrowserFillResult,
  type FocusedElement,
  type FocusedFillOptions,
  fillFocused,
} from "../fill/browser.ts";
import type { SecretRedactor } from "../redact.ts";
import {
  type CardFile,
  type LineItem,
  type LinkWallet,
  type MaskedCard,
  parseCardFile,
  type ReportOutcome,
  SPEND_WAITING,
  type SpendRequest,
  type SpendStatus,
} from "./link.ts";

/** What the agent asks to buy. Amounts are integers in minor units (security §3.5). */
export interface PurchaseInput {
  merchantName: string;
  /** The checkout's https URL; its host is the merchant identity in the binding. */
  merchantUrl: string;
  amount: number;
  currency: string;
  lineItems: LineItem[];
  /** Link test mode: test cards, no charge. */
  test?: boolean;
  /** The Link payment method that funds it (`csmrpd_…`); default: the owner's default method. */
  paymentMethodId?: string;
}

/** What funds a purchase, as the card shows it and the binding covers it (security §3.5). */
export interface PaymentSource {
  id: string;
  brand: string;
  last4: string;
}

/**
 * The merchant's side of a spend, as the executor observes it: an authorization hold on the
 * one-time card, its capture, refunds, a decline, or the hold released without capture.
 */
export type PaymentState =
  | "none"
  | "held"
  | "captured"
  | "partially_refunded"
  | "refunded"
  | "declined"
  | "released";

export interface PaymentLedger {
  state: PaymentState;
  held: number;
  captured: number;
  refunded: number;
  /** Merchant references in order: hold, order / confirmation, refund ids. Never card data. */
  refs: Record<string, string>;
}

export interface PurchaseRequester {
  requestedBy: ApprovalRequestInput["requestedBy"];
  taint: boolean;
  surfaces?: Surface[];
}

/** Non-secret record of one spend, kept in `vault/payments/<id>.json` (0600). */
export interface SpendRecord {
  spendRequestId: string;
  approvalId: string;
  taskId: string | null;
  merchantName: string;
  merchantHost: string;
  amount: number;
  currency: string;
  status: SpendStatus;
  approvalUrl: string | null;
  card: MaskedCard | null;
  /** The owner's Link payment method behind the one-time card (brand / last4 only). */
  fundingSource: PaymentSource | null;
  payment: PaymentLedger;
  createdAt: number;
  revealedAt: number | null;
}

const NO_PAYMENT = (): PaymentLedger => ({
  state: "none",
  held: 0,
  captured: 0,
  refunded: 0,
  refs: {},
});

export type CardField = "number" | "exp" | "exp_month" | "exp_year" | "cvc" | "name" | "postal";

export interface PaymentBrokerOptions {
  /** `$PSYCHE_HOME`; card files go to `vault/cards/`, records to `vault/payments/`. */
  home: string;
  wallet: LinkWallet;
  permissions: PermissionBroker;
  /** The vault's redactor, so card values are masked on every output path. */
  redactor: SecretRedactor;
  audit?: AuditLog;
  clock?: Clock;
  /** Card files are shredded this long after reveal even without `complete` (default 2 h). */
  cardTtlMs?: number;
}

/** Link's own ceiling per spend request (USD minor units). */
export const LINK_MAX_USD_MINOR = 50_000;

/** `visa` → `Visa` for cards and receipts. */
export function brandName(brand: string): string {
  const known: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    bank_account: "Bank account",
    link_balance: "Link balance",
  };
  return known[brand.toLowerCase()] ?? brand;
}

/** Minor-unit exponent per ISO 4217 code, from Intl (JPY 0, USD 2, KWD 3). */
function exponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return fail("invalid_params", `unknown currency ${currency}`);
  }
}

export function formatAmount(amount: number, currency: string): string {
  const exp = exponent(currency);
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
  }).format(amount / 10 ** exp);
}

/**
 * Binding fields of a purchase (security §3.5): merchant host, amount, currency, line items and
 * the payment source. With `source`, the source is the Link payment method (id and last4), so an
 * approval for one funding card cannot pay with another.
 */
export function purchaseBindingHash(
  input: PurchaseInput,
  source?: PaymentSource,
): `sha256:${string}` {
  const host = canonicalHost(input.merchantUrl) ?? "";
  const items = [...input.lineItems]
    .map((li) => ({ name: li.name, qty: li.quantity, unitPrice: li.unitAmount }))
    .sort((a, b) => strictCanonicalJSON(a).localeCompare(strictCanonicalJSON(b)));
  const lineItemHash = createHash("sha256").update(strictCanonicalJSON(items)).digest("hex");
  const fields = {
    amount: input.amount,
    currency: input.currency,
    lineItemHash,
    merchant: host,
    paymentSource: source === undefined ? "stripe_link" : `stripe_link:${source.id}`,
    ...(source === undefined ? {} : { cardLast4: source.last4 }),
  };
  const text = `psyche.binding.v1|purchase|${strictCanonicalJSON(fields)}`;
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * The context Link shows the owner. Built by Psyche from the approved facts, never from agent
 * text, so a page cannot write the approval prompt (Link requires ≥100 characters).
 */
export function spendContext(input: PurchaseInput): string {
  const items = input.lineItems.map((li) => `${li.quantity} × ${li.name}`).join(", ");
  return (
    `Psyche, the owner's personal agent, is paying ${formatAmount(input.amount, input.currency)} to ` +
    `${input.merchantName} (${canonicalHost(input.merchantUrl) ?? input.merchantUrl}) for: ${items}. ` +
    "The owner approved this exact amount and merchant in Psyche before this request."
  );
}

/** Which page fields a card value may go into. Top frame only; inputs only. */
export function cardFieldAccepts(
  field: CardField,
  el: FocusedElement,
): { ok: true } | { ok: false; reason: string } {
  if (el.tagName !== "input") return { ok: false, reason: `not_input:${el.tagName}` };
  if (el.contentEditable === true) return { ok: false, reason: "contenteditable" };
  const type = (el.type ?? "text").toLowerCase();
  if (!["text", "tel", "number", "password", ""].includes(type))
    return { ok: false, reason: `input_type:${type}` };
  const ac = (el.autocomplete ?? "").toLowerCase().split(/\s+/);
  const name = el.fieldName ?? "";
  const rules: Record<CardField, [string, RegExp]> = {
    number: ["cc-number", /(card|cc)[-_ ]?(number|num|no)\b|cardnumber|ccnumber/],
    exp: ["cc-exp", /^(cc[-_]?)?exp(iry|iration)?([-_]?date)?$/],
    exp_month: ["cc-exp-month", /exp.*(month|mm)\b/],
    exp_year: ["cc-exp-year", /exp.*(year|yy)/],
    cvc: ["cc-csc", /\b(cvc|cvv|csc|cvv2|security[-_ ]?code)\b/],
    name: ["cc-name", /(card|cc)[-_ ]?(holder|name)|name[-_ ]?on[-_ ]?card/],
    postal: ["postal-code", /\b(zip|postal)/],
  };
  const [token, pattern] = rules[field];
  if (ac.includes(token) || pattern.test(name)) return { ok: true };
  return { ok: false, reason: `not_${field}_field` };
}

const WAITING: readonly SpendStatus[] = SPEND_WAITING;

/**
 * Payments through Stripe Link Agent Wallet (security §4.9, feature G12):
 * 1. `requestPurchase` issues a `purchase` ApprovalRequest (financial, device-only, `once`,
 *    authenticated) bound to merchant + amount + currency + line items.
 * 2. `authorize` re-verifies that binding (consuming the approval) and creates the Link spend
 *    request; the owner approves it in Link within 30 minutes.
 * 3. `awaitCard` waits for approval and has Link write the one-time card to a 0600 file under
 *    `vault/cards/`; only brand / last4 / expiry come back.
 * 4. `fillCard` types one card field into the merchant's top-frame checkout (origin and field
 *    checked) through the browser fill core.
 * 5. `complete` shreds the card file, reports the outcome to Link and records the receipt with
 *    the Link spend request id, order number and confirmation.
 * Card numbers never reach the model, the vault database, logs, events or the receipt.
 */
export class PaymentBroker {
  readonly #o: PaymentBrokerOptions;
  readonly #clock: Clock;
  readonly #cards: string;
  readonly #records: string;
  readonly #ledger = new Map<string, SpendRecord>();

  constructor(options: PaymentBrokerOptions) {
    this.#o = options;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#cards = join(options.home, "vault", "cards");
    this.#records = join(options.home, "vault", "payments");
    for (const dir of [this.#cards, this.#records])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(this.#records)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.#records, f), "utf8")) as SpendRecord;
        rec.payment ??= NO_PAYMENT();
        rec.fundingSource ??= null;
        this.#ledger.set(rec.spendRequestId, rec);
      } catch {
        // A damaged record is ignored; its card file is shredded by `sweep`.
      }
    }
  }

  #save(rec: SpendRecord): void {
    this.#ledger.set(rec.spendRequestId, rec);
    const path = join(this.#records, `${rec.spendRequestId}.json`);
    const fd = openSync(path, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(rec));
    } finally {
      closeSync(fd);
    }
  }

  #cardPath(id: string): string {
    if (!/^lsrq_[A-Za-z0-9]+$/.test(id))
      return fail("invalid_params", "not a Link spend request id");
    return join(this.#cards, `${id}.json`);
  }

  async #audit(kind: string, data: JsonObject): Promise<void> {
    await this.#o.audit?.append({ kind, actor: { type: "system" }, data });
  }

  get(spendRequestId: string): SpendRecord | undefined {
    const r = this.#ledger.get(spendRequestId);
    return r === undefined ? undefined : structuredClone(r);
  }

  #validate(input: PurchaseInput): void {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      fail("invalid_params", "amount must be a positive integer in minor units");
    }
    if (!/^[a-z]{3}$/.test(input.currency))
      fail("invalid_params", "currency must be a lowercase ISO 4217 code");
    exponent(input.currency.toUpperCase());
    if (!URL.canParse(input.merchantUrl)) fail("invalid_params", "merchantUrl must be a URL");
    if (new URL(input.merchantUrl).protocol !== "https:") {
      fail("invalid_params", "merchantUrl must be https");
    }
    if (input.merchantName.trim().length === 0 || input.merchantName.length > 200) {
      fail("invalid_params", "merchantName is required");
    }
    if (input.lineItems.length === 0) fail("invalid_params", "at least one line item");
    let sum = 0;
    for (const li of input.lineItems) {
      if (
        !Number.isSafeInteger(li.quantity) ||
        li.quantity <= 0 ||
        !Number.isSafeInteger(li.unitAmount) ||
        li.unitAmount < 0
      ) {
        fail("invalid_params", "line items need integer quantity and unit amount");
      }
      sum += li.quantity * li.unitAmount;
    }
    if (sum > input.amount) fail("invalid_params", "line items exceed the amount");
    if (input.currency === "usd" && input.amount > LINK_MAX_USD_MINOR) {
      fail("policy_denied", "Link allows at most $500 per purchase", { reason: "link_limit" });
    }
  }

  /** Step 1: the device-only, authenticated `purchase` approval. */
  async requestPurchase(input: PurchaseInput, req: PurchaseRequester): Promise<IssuedApproval> {
    this.#validate(input);
    const limits = await this.#o.wallet.spendLimits();
    if (
      limits.currency === input.currency &&
      limits.perTransaction !== null &&
      input.amount > limits.perTransaction
    ) {
      return fail("policy_denied", "the amount is over the owner's Link per-transaction limit", {
        reason: "spend_limit",
      });
    }
    const host = canonicalHost(input.merchantUrl) ?? "";
    const display = formatAmount(input.amount, input.currency.toUpperCase());
    const source = await this.resolveSource(input);
    const funded = `${brandName(source.brand)} •••• ${source.last4}`;
    return this.#o.permissions.requestApproval({
      kind: "purchase",
      summary: `Pay ${display} to ${input.merchantName} (${host}) with Stripe Link, funded by ${funded}`,
      details: {
        merchant: input.merchantName,
        merchantHost: host,
        amount: input.amount,
        amountDisplay: display,
        currency: input.currency,
        lineItems: input.lineItems.map((li) => ({
          name: li.name,
          quantity: li.quantity,
          unitAmount: li.unitAmount,
        })),
        paymentSource: "Stripe Link (one-time card)",
        paymentMethod: { id: source.id, brand: source.brand, last4: source.last4, display: funded },
        test: input.test === true,
        task: req.requestedBy.taskId,
        agent: req.requestedBy.agent ?? null,
        requiresAuthentication: true,
      },
      bindingHash: purchaseBindingHash(input, source),
      grantKey: `purchase|${host}`,
      requestedBy: req.requestedBy,
      sideEffect: "financial",
      targetKind: "origin",
      target: { kind: "origin", value: `https://${host}` },
      surfaces: req.surfaces ?? ["desktop", "notification"],
      scopesOffered: ["once"],
      taint: req.taint,
    });
  }

  /** Step 2: verify the exact purchase (consumes the approval) and create the Link spend request. */
  async authorize(approvalId: string, input: PurchaseInput): Promise<SpendRecord> {
    this.#validate(input);
    const source = await this.resolveSource(input);
    const verified = await this.#o.permissions.verifyBinding(
      approvalId,
      purchaseBindingHash(input, source),
    );
    if (!verified.ok) {
      return fail("approval_required", "the purchase is not approved as requested", {
        reason: `approval_${verified.reason}`,
      });
    }
    if (verified.approval.kind !== "purchase") {
      return fail("approval_required", "the approval is not a purchase", {
        reason: "approval_wrong_kind",
      });
    }
    return this.#createSpend(
      approvalId,
      verified.approval.requestedBy.taskId ?? null,
      input,
      source,
    );
  }

  /**
   * The Link payment method that funds `input`: the one it names, else the owner's default, else
   * the first card. Refuses when Link has none or the named one is gone.
   */
  async resolveSource(input: Pick<PurchaseInput, "paymentMethodId">): Promise<PaymentSource> {
    const methods = await this.#o.wallet.paymentMethods();
    const pick =
      input.paymentMethodId === undefined
        ? (methods.find((m) => m.isDefault) ??
          methods.find((m) => m.brand !== "link_balance") ??
          methods[0])
        : methods.find((m) => m.id === input.paymentMethodId);
    if (pick === undefined) {
      return fail("unavailable", "no Link payment method to fund this purchase", {
        reason: input.paymentMethodId === undefined ? "no_payment_method" : "payment_method_gone",
      });
    }
    return { id: pick.id, brand: pick.brand, last4: pick.last4 };
  }

  /**
   * Step 2 for a purchase tool the agent loop already dispatched: the loop verified (and
   * consumed) the `once` purchase approval against `bindingHash`, the hash of these exact
   * arguments in the loop's recipe. The broker re-checks the request itself rather than trusting
   * the caller: approved, kind `purchase`, scope `once`, the same binding hash, not invalidated
   * since; and an approval pays at most one spend request.
   */
  async authorizeDispatched(
    approvalId: string,
    input: PurchaseInput,
    bindingHash: string,
  ): Promise<SpendRecord> {
    this.#validate(input);
    const approval = await this.#o.permissions.get(approvalId);
    const reason =
      approval === undefined
        ? "approval_not_found"
        : approval.status !== "approved"
          ? `approval_${approval.status}`
          : approval.kind !== "purchase"
            ? "approval_wrong_kind"
            : approval.scopeGranted !== "once"
              ? "approval_not_once"
              : approval.bindingHash !== bindingHash
                ? "approval_binding_mismatch"
                : [...this.#ledger.values()].some((r) => r.approvalId === approvalId)
                  ? "approval_consumed"
                  : null;
    if (reason !== null || approval === undefined) {
      return fail("approval_required", "the purchase is not approved as requested", {
        reason: reason ?? "approval_not_found",
      });
    }
    return this.#createSpend(
      approvalId,
      approval.requestedBy.taskId ?? null,
      input,
      await this.resolveSource(input),
    );
  }

  async #createSpend(
    approvalId: string,
    taskId: string | null,
    input: PurchaseInput,
    source: PaymentSource,
  ): Promise<SpendRecord> {
    const sr = await this.#o.wallet.create({
      paymentMethodId: source.id,
      amount: input.amount,
      currency: input.currency,
      context: spendContext(input),
      merchantName: input.merchantName,
      merchantUrl: input.merchantUrl,
      lineItems: input.lineItems,
      ...(input.test === true ? { test: true } : {}),
    });
    if (sr.amount !== input.amount || sr.currency !== input.currency) {
      await this.#o.wallet.cancel(sr.id).catch(() => undefined);
      return fail("internal", "Link created a spend request for a different amount");
    }
    const rec: SpendRecord = {
      spendRequestId: sr.id,
      approvalId,
      taskId,
      merchantName: input.merchantName,
      merchantHost: canonicalHost(input.merchantUrl) ?? "",
      amount: input.amount,
      currency: input.currency,
      status: sr.status,
      approvalUrl: sr.approvalUrl,
      card: null,
      fundingSource: source,
      payment: NO_PAYMENT(),
      createdAt: this.#clock.now(),
      revealedAt: null,
    };
    this.#save(rec);
    await this.#audit("purchase.requested", {
      spendRequestId: sr.id,
      approvalId,
      merchant: rec.merchantHost,
      amount: rec.amount,
      currency: rec.currency,
    });
    return structuredClone(rec);
  }

  /**
   * Step 3: wait for the owner's decision in Link. On approval, Link writes the card to a 0600
   * file; its number and CVC are registered with the redactor; the masked card comes back.
   */
  async awaitCard(spendRequestId: string): Promise<SpendRecord> {
    const rec = this.#ledger.get(spendRequestId);
    if (rec === undefined) return fail("not_found", "unknown spend request");
    let sr: SpendRequest = await this.#o.wallet.retrieve(spendRequestId, { wait: true });
    if (sr.status === "requires_action" && sr.requiresAction?.resolution !== "auto_resume") {
      rec.status = sr.status;
      this.#save(rec);
      return fail("unavailable", "Link needs the owner to act on the payment method first", {
        reason: "requires_action",
      });
    }
    if (WAITING.includes(sr.status))
      sr = await this.#o.wallet.retrieve(spendRequestId, { wait: true });
    rec.status = sr.status;
    if (sr.status !== "approved") {
      this.#save(rec);
      await this.#audit("purchase.not_approved", { spendRequestId, status: sr.status });
      return fail("approval_required", `the owner did not approve in Link (${sr.status})`, {
        reason: `link_${sr.status}`,
      });
    }
    const path = this.#cardPath(spendRequestId);
    if (existsSync(path)) shred(path);
    const masked = await this.#o.wallet.revealCard(spendRequestId, path);
    const card = this.#readCard(path);
    for (const v of [card.number, card.cvc]) this.#o.redactor.add(v, { sticky: true });
    rec.card = masked.card;
    rec.revealedAt = this.#clock.now();
    this.#save(rec);
    return structuredClone(rec);
  }

  #readCard(path: string): CardFile {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return fail("internal", "Link wrote no card file");
    }
    if ((st.mode & 0o077) !== 0) {
      shred(path);
      return fail("internal", "the card file was not private (0600); it was destroyed");
    }
    return parseCardFile(readFileSync(path, "utf8"));
  }

  #value(card: CardFile, field: CardField): string | undefined {
    const mm = String(card.expMonth).padStart(2, "0");
    switch (field) {
      case "number":
        return card.number;
      case "cvc":
        return card.cvc;
      case "exp":
        return `${mm}/${String(card.expYear).slice(-2)}`;
      case "exp_month":
        return mm;
      case "exp_year":
        return String(card.expYear);
      case "name":
        return card.name;
      case "postal":
        return card.postalCode;
    }
  }

  /**
   * Step 4: type one card field into the focused checkout field. The top frame must be the
   * merchant's https site (its host or a subdomain), the field must look like that card field,
   * and the spend request must be approved with a live card file. Card fields inside a payment
   * iframe (Stripe Elements on js.stripe.com) are refused: use a Link Pay Token there instead.
   */
  fillCard(
    opts: FocusedFillOptions & { spendRequestId: string; field: CardField },
  ): Promise<BrowserFillResult> {
    return fillFocused(opts, async (origin, element) => {
      const rec = this.#ledger.get(opts.spendRequestId);
      if (
        rec === undefined ||
        rec.status !== "approved" ||
        rec.revealedAt === null ||
        rec.payment.state !== "none"
      ) {
        return fail("approval_required", "no approved Link card for this purchase", {
          reason: "no_card",
        });
      }
      const url = new URL(origin);
      const host = url.host;
      if (
        url.protocol !== "https:" ||
        (host !== rec.merchantHost && !host.endsWith(`.${rec.merchantHost}`))
      ) {
        return fail("policy_denied", "the checkout is not on the approved merchant's site", {
          reason: "merchant_mismatch",
        });
      }
      if (element.frameOrigin !== origin) {
        return fail("policy_denied", "card fields in another frame are not filled", {
          reason: "card_field_in_frame",
        });
      }
      const check = cardFieldAccepts(opts.field, element);
      if (!check.ok)
        return fail("policy_denied", "the focused field is not that card field", {
          reason: check.reason,
        });
      const value = this.#value(this.#readCard(this.#cardPath(rec.spendRequestId)), opts.field);
      if (value === undefined)
        return fail("not_found", `the card has no ${opts.field}`, { reason: "no_such_field" });
      await this.#audit("purchase.card_filled", {
        spendRequestId: rec.spendRequestId,
        field: opts.field,
        origin,
      });
      return new ResolvedSecret(value, {
        credentialId: rec.spendRequestId,
        target: { kind: "origin", value: origin },
      });
    });
  }

  /**
   * One lifecycle transition: refuse it unless the ledger is in one of `from`, then shred the
   * card when it is no longer needed, record the receipt (Link reference + merchant refs, brand /
   * last4 only) and the audit entry with the receipt id.
   */
  async #transition(
    spendRequestId: string,
    t: {
      from: PaymentState[];
      to: PaymentState;
      kind: string;
      outcome: "ok" | "failed";
      summary: (rec: SpendRecord) => string;
      refs?: Record<string, string | undefined>;
      apply?: (rec: SpendRecord) => void;
      check?: (rec: SpendRecord) => void;
      report?: { outcome: ReportOutcome; tags?: string[] };
      toolCallId?: string;
      /** The approval that authorized this step, when it is not the purchase's own (ticketing a hold). */
      approvalId?: string;
      payload?: JsonObject;
    },
  ): Promise<Receipt> {
    const rec = this.#ledger.get(spendRequestId);
    if (rec === undefined) return fail("not_found", "unknown spend request");
    if (!t.from.includes(rec.payment.state)) {
      return fail("conflict", `cannot go from ${rec.payment.state} to ${t.to}`, {
        reason: `payment_${rec.payment.state}`,
      });
    }
    t.check?.(rec);
    // The card is needed only until the merchant authorizes it.
    shred(this.#cardPath(spendRequestId));
    if (t.report !== undefined) {
      await this.#o.wallet
        .report({
          domain: rec.merchantHost,
          outcome: t.report.outcome,
          spendRequestId,
          ...(t.report.tags ? { tags: t.report.tags } : {}),
        })
        .catch(() => undefined);
    }
    t.apply?.(rec);
    rec.payment.state = t.to;
    const externalRefs: Record<string, string> = { linkSpendRequestId: spendRequestId };
    for (const [k, v] of Object.entries(t.refs ?? {})) {
      if (v === undefined) continue;
      const clean = this.#o.redactor.redact(v);
      externalRefs[k] = clean;
      rec.payment.refs[k] = clean;
    }
    const receipt = await this.#o.permissions.recordReceipt({
      kind: t.kind,
      outcome: t.outcome,
      summary: t.summary(rec),
      taskId: rec.taskId,
      approvalId: t.approvalId ?? rec.approvalId,
      ...(t.toolCallId === undefined ? {} : { toolCallId: t.toolCallId }),
      externalRefs,
      payload: {
        merchant: rec.merchantHost,
        amount: rec.amount,
        currency: rec.currency,
        card: rec.card === null ? null : { brand: rec.card.brand, last4: rec.card.last4 },
        fundingSource:
          rec.fundingSource === null
            ? null
            : { brand: rec.fundingSource.brand, last4: rec.fundingSource.last4 },
        payment: {
          state: rec.payment.state,
          held: rec.payment.held,
          captured: rec.payment.captured,
          refunded: rec.payment.refunded,
        },
        ...t.payload,
      },
    });
    this.#save(rec);
    await this.#audit(`purchase.${t.to}`, {
      spendRequestId,
      receiptId: receipt.id,
      receiptKind: t.kind,
      state: t.to,
      approvalId: t.approvalId ?? rec.approvalId,
      held: rec.payment.held,
      captured: rec.payment.captured,
      refunded: rec.payment.refunded,
      currency: rec.currency,
    });
    return receipt;
  }

  #cardTail(rec: SpendRecord): string {
    return rec.card === null ? "" : ` (${rec.card.brand} •••• ${rec.card.last4})`;
  }

  #money(rec: SpendRecord, amount: number): string {
    return formatAmount(amount, rec.currency.toUpperCase());
  }

  #cardWasRevealed(rec: SpendRecord): void {
    if (rec.status !== "approved" || rec.revealedAt === null) {
      fail("approval_required", "no approved Link card for this purchase", { reason: "no_card" });
    }
  }

  /**
   * The merchant authorized the one-time card without capturing it (a fare hold, a pre-order).
   * The hold may not exceed the approved amount: an increase needs a new approval and spend
   * request (security §4.9 step 5). The card file is shredded: capture needs no card.
   */
  hold(
    spendRequestId: string,
    r: {
      amount?: number;
      holdRef: string;
      expiresAt?: string;
      toolCallId?: string;
      payload?: JsonObject;
    },
  ): Promise<Receipt> {
    return this.#transition(spendRequestId, {
      from: ["none"],
      to: "held",
      kind: "purchase.hold",
      outcome: "ok",
      check: (rec) => {
        this.#cardWasRevealed(rec);
        const amount = r.amount ?? rec.amount;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > rec.amount) {
          fail("policy_denied", "the hold is more than the approved amount", {
            reason: "amount_increase",
          });
        }
      },
      apply: (rec) => {
        rec.payment.held = r.amount ?? rec.amount;
      },
      refs: { holdRef: r.holdRef, holdExpiresAt: r.expiresAt },
      summary: (rec) =>
        `Held ${this.#money(rec, rec.payment.held)} at ${rec.merchantName}${this.#cardTail(rec)}`,
      ...(r.toolCallId === undefined ? {} : { toolCallId: r.toolCallId }),
      ...(r.payload === undefined ? {} : { payload: r.payload }),
    });
  }

  /**
   * The merchant captured: from a hold (up to the held amount) or directly after the fill (up to
   * the approved amount). Records the `purchase` receipt with the order number and confirmation.
   */
  capture(
    spendRequestId: string,
    r: {
      amount?: number;
      orderNumber?: string;
      merchantConfirmation?: string;
      toolCallId?: string;
      approvalId?: string;
      payload?: JsonObject;
    },
  ): Promise<Receipt> {
    return this.#transition(spendRequestId, {
      ...(r.approvalId === undefined ? {} : { approvalId: r.approvalId }),
      from: ["none", "held"],
      to: "captured",
      kind: "purchase",
      outcome: "ok",
      check: (rec) => {
        if (rec.payment.state === "none") this.#cardWasRevealed(rec);
        const limit = rec.payment.state === "held" ? rec.payment.held : rec.amount;
        const amount = r.amount ?? limit;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > limit) {
          fail("policy_denied", "the capture is more than was approved or held", {
            reason: "amount_increase",
          });
        }
      },
      apply: (rec) => {
        rec.payment.captured =
          r.amount ?? (rec.payment.state === "held" ? rec.payment.held : rec.amount);
        rec.status = "succeeded";
      },
      refs: { orderNumber: r.orderNumber, merchantConfirmation: r.merchantConfirmation },
      report: { outcome: "success" },
      summary: (rec) =>
        `Paid ${this.#money(rec, rec.payment.captured)} to ${rec.merchantName}${this.#cardTail(rec)}`,
      ...(r.toolCallId === undefined ? {} : { toolCallId: r.toolCallId }),
      payload: { outcome: "success", ...r.payload },
    });
  }

  /** The merchant refunded part or all of a capture; refunds never exceed what was captured. */
  refund(
    spendRequestId: string,
    r: {
      amount?: number;
      refundRef: string;
      reason?: string;
      toolCallId?: string;
      approvalId?: string;
      payload?: JsonObject;
    },
  ): Promise<Receipt> {
    let amount = 0;
    return this.#transition(spendRequestId, {
      ...(r.approvalId === undefined ? {} : { approvalId: r.approvalId }),
      from: ["captured", "partially_refunded"],
      to: "refunded",
      kind: "purchase.refund",
      outcome: "ok",
      check: (rec) => {
        amount = r.amount ?? rec.payment.captured - rec.payment.refunded;
        if (
          !Number.isSafeInteger(amount) ||
          amount <= 0 ||
          rec.payment.refunded + amount > rec.payment.captured
        ) {
          fail("invalid_params", "the refund is more than was captured", {
            reason: "refund_exceeds_capture",
          });
        }
      },
      apply: (rec) => {
        rec.payment.refunded += amount;
      },
      refs: { refundRef: r.refundRef },
      summary: (rec) =>
        `Refunded ${this.#money(rec, amount)} from ${rec.merchantName}${this.#cardTail(rec)}`,
      ...(r.toolCallId === undefined ? {} : { toolCallId: r.toolCallId }),
      payload: {
        refundAmount: amount,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...r.payload,
      },
    }).then((receipt) => {
      const rec = this.#ledger.get(spendRequestId);
      if (rec !== undefined && rec.payment.refunded < rec.payment.captured) {
        rec.payment.state = "partially_refunded";
        this.#save(rec);
      }
      return receipt;
    });
  }

  /** The merchant declined the card; nothing was charged. */
  decline(
    spendRequestId: string,
    r: { code?: string; toolCallId?: string; payload?: JsonObject } = {},
  ): Promise<Receipt> {
    return this.#transition(spendRequestId, {
      from: ["none", "held"],
      to: "declined",
      kind: "purchase.declined",
      outcome: "failed",
      apply: (rec) => {
        rec.payment.held = 0;
        rec.status = "failed";
      },
      refs: { declineCode: r.code },
      report: { outcome: "blocked", tags: ["payment_declined"] },
      summary: (rec) =>
        `${rec.merchantName} declined the card; nothing was charged${this.#cardTail(rec)}`,
      ...(r.toolCallId === undefined ? {} : { toolCallId: r.toolCallId }),
      ...(r.payload === undefined ? {} : { payload: r.payload }),
    });
  }

  /** A hold ended without capture (it expired, or the owner did not buy); nothing was charged. */
  releaseHold(
    spendRequestId: string,
    r: { reason?: string; toolCallId?: string; payload?: JsonObject } = {},
  ): Promise<Receipt> {
    return this.#transition(spendRequestId, {
      from: ["held"],
      to: "released",
      kind: "purchase.hold_released",
      outcome: "ok",
      apply: (rec) => {
        rec.payment.held = 0;
      },
      report: { outcome: "abandoned" },
      summary: (rec) =>
        `Released the hold at ${rec.merchantName}; nothing was charged${this.#cardTail(rec)}`,
      ...(r.toolCallId === undefined ? {} : { toolCallId: r.toolCallId }),
      payload: { ...(r.reason === undefined ? {} : { reason: r.reason }), ...r.payload },
    });
  }

  /**
   * Step 5 for a direct sale: `success` captures the full approved (or held) amount; `blocked`
   * with `payment_declined` is a decline; anything else ends the purchase without a charge.
   */
  async complete(
    spendRequestId: string,
    result: {
      outcome: ReportOutcome;
      orderNumber?: string;
      merchantConfirmation?: string;
      tags?: string[];
      /** Extra receipt payload, e.g. an evaluator verdict (never card data). */
      payload?: JsonObject;
      /** The tool call that paid, when an agent tool drove the purchase. */
      toolCallId?: string;
    },
  ): Promise<Receipt> {
    const extra = {
      ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
      ...(result.payload === undefined ? {} : { payload: result.payload }),
    };
    if (result.outcome === "success") {
      return this.capture(spendRequestId, {
        ...(result.orderNumber === undefined ? {} : { orderNumber: result.orderNumber }),
        ...(result.merchantConfirmation === undefined
          ? {}
          : { merchantConfirmation: result.merchantConfirmation }),
        ...extra,
      });
    }
    if (result.tags?.includes("payment_declined") === true)
      return this.decline(spendRequestId, extra);
    const rec = this.#ledger.get(spendRequestId);
    if (rec?.payment.state === "held")
      return this.releaseHold(spendRequestId, { reason: result.outcome, ...extra });
    return this.#transition(spendRequestId, {
      from: ["none"],
      to: "none",
      kind: "purchase",
      outcome: "failed",
      apply: (r) => {
        r.status = "failed";
      },
      report: { outcome: result.outcome, ...(result.tags ? { tags: result.tags } : {}) },
      summary: (r) => `Purchase from ${r.merchantName} ${result.outcome}${this.#cardTail(r)}`,
      ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
      payload: { outcome: result.outcome, ...result.payload },
    });
  }

  /** Cancel in Link (when still possible) and shred the card. */
  async cancel(spendRequestId: string): Promise<SpendRecord> {
    const rec = this.#ledger.get(spendRequestId);
    if (rec === undefined) return fail("not_found", "unknown spend request");
    shred(this.#cardPath(spendRequestId));
    const sr = await this.#o.wallet.cancel(spendRequestId).catch(() => undefined);
    rec.status = sr?.status ?? "canceled";
    this.#save(rec);
    await this.#audit("purchase.canceled", { spendRequestId });
    return structuredClone(rec);
  }

  /** Shred card files past their TTL and those with no live record. Returns how many. */
  sweep(): number {
    const ttl = this.#o.cardTtlMs ?? 2 * 60 * 60_000;
    let n = 0;
    for (const f of readdirSync(this.#cards)) {
      const id = f.replace(/\.json$/, "");
      const rec = this.#ledger.get(id);
      const stale =
        rec === undefined ||
        rec.status !== "approved" ||
        rec.revealedAt === null ||
        rec.payment.state !== "none" ||
        this.#clock.now() - rec.revealedAt > ttl;
      if (stale) {
        shred(join(this.#cards, f));
        n += 1;
      }
    }
    return n;
  }
}

/** Overwrite with zeros, flush, unlink. Missing files are fine. */
export function shred(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  try {
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, Buffer.alloc(size));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(path, { force: true });
  }
}
