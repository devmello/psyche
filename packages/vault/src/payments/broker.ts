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
  createdAt: number;
  revealedAt: number | null;
}

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

/** Binding fields of a purchase (security §3.5): merchant host, amount, currency, line items, source. */
export function purchaseBindingHash(input: PurchaseInput): `sha256:${string}` {
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
    paymentSource: "stripe_link",
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
    let url: URL;
    try {
      url = new URL(input.merchantUrl);
    } catch {
      return fail("invalid_params", "merchantUrl must be a URL");
    }
    if (url.protocol !== "https:") fail("invalid_params", "merchantUrl must be https");
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
    return this.#o.permissions.requestApproval({
      kind: "purchase",
      summary: `Pay ${display} to ${input.merchantName} (${host}) with Stripe Link`,
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
        test: input.test === true,
        task: req.requestedBy.taskId,
        agent: req.requestedBy.agent ?? null,
        requiresAuthentication: true,
      },
      bindingHash: purchaseBindingHash(input),
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
    const verified = await this.#o.permissions.verifyBinding(
      approvalId,
      purchaseBindingHash(input),
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
    const sr = await this.#o.wallet.create({
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
      taskId: verified.approval.requestedBy.taskId ?? null,
      merchantName: input.merchantName,
      merchantHost: canonicalHost(input.merchantUrl) ?? "",
      amount: input.amount,
      currency: input.currency,
      status: sr.status,
      approvalUrl: sr.approvalUrl,
      card: null,
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
      if (rec === undefined || rec.status !== "approved" || rec.revealedAt === null) {
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

  /** Step 5: shred the card, tell Link how it went, and record the receipt. */
  async complete(
    spendRequestId: string,
    result: {
      outcome: ReportOutcome;
      orderNumber?: string;
      merchantConfirmation?: string;
      tags?: string[];
    },
  ): Promise<Receipt> {
    const rec = this.#ledger.get(spendRequestId);
    if (rec === undefined) return fail("not_found", "unknown spend request");
    shred(this.#cardPath(spendRequestId));
    await this.#o.wallet
      .report({
        domain: rec.merchantHost,
        outcome: result.outcome,
        spendRequestId,
        ...(result.tags ? { tags: result.tags } : {}),
      })
      .catch(() => undefined);
    const card = rec.card === null ? "" : ` (${rec.card.brand} •••• ${rec.card.last4})`;
    const display = formatAmount(rec.amount, rec.currency.toUpperCase());
    const externalRefs: Record<string, string> = { linkSpendRequestId: spendRequestId };
    if (result.orderNumber !== undefined)
      externalRefs.orderNumber = this.#o.redactor.redact(result.orderNumber);
    if (result.merchantConfirmation !== undefined) {
      externalRefs.merchantConfirmation = this.#o.redactor.redact(result.merchantConfirmation);
    }
    const receipt = await this.#o.permissions.recordReceipt({
      kind: "purchase",
      outcome: result.outcome === "success" ? "ok" : "failed",
      summary:
        result.outcome === "success"
          ? `Paid ${display} to ${rec.merchantName}${card}`
          : `Purchase from ${rec.merchantName} ${result.outcome}${card}`,
      taskId: rec.taskId,
      approvalId: rec.approvalId,
      externalRefs,
      payload: {
        merchant: rec.merchantHost,
        amount: rec.amount,
        currency: rec.currency,
        card: rec.card === null ? null : { brand: rec.card.brand, last4: rec.card.last4 },
        outcome: result.outcome,
      },
    });
    rec.status = result.outcome === "success" ? "succeeded" : "failed";
    this.#save(rec);
    await this.#audit("purchase.completed", {
      spendRequestId,
      outcome: result.outcome,
      receiptId: receipt.id,
    });
    return receipt;
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
