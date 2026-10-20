// V3 payment fakes. The vault's payment code is imported by relative path, like the other real
// packages in this runner (they list @psyche/testing as a devDependency).
import { existsSync, writeFileSync } from "node:fs";
import type { CdpSession, FocusedElement } from "../../../vault/src/fill/browser.ts";
import type {
  LinkWallet,
  PaymentMethod,
  ReportOutcome,
  SpendLimits,
  SpendRequest,
  SpendRequestInput,
} from "../../../vault/src/payments/link.ts";
import { fixtureSecret, loadSecretRegistry } from "../secret-registry.ts";

/** The registry's Link test card (`link-virtual-card`: published test number, display 12/34). */
export function linkTestCard(): {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  brand: string;
} {
  const entry = loadSecretRegistry().standalone.find((s) => s.id === "link-virtual-card") as
    | { display?: { brand?: string; exp?: string } }
    | undefined;
  const [mm, yy] = (entry?.display?.exp ?? "12/34").split("/");
  return {
    number: fixtureSecret("link-virtual-card"),
    // Link test mode issues a fixed CVC; three digits are below the leak checker's minimum and are
    // covered by the 0600 file and the fill path instead.
    cvc: "123",
    expMonth: Number(mm),
    expYear: 2000 + Number(yy),
    brand: entry?.display?.brand ?? "visa",
  };
}

/**
 * Stripe Link Agent Wallet in test mode: spend requests in memory, the owner's approval in the
 * Link app answered by `decision`, the one-time card written 0600 to the file the broker names.
 * `requests` records what Link saw (never card data).
 */
export class ScenarioLinkWallet implements LinkWallet {
  readonly requests: SpendRequestInput[] = [];
  readonly reports: { domain: string; outcome: ReportOutcome; spendRequestId: string }[] = [];
  decision: "approved" | "denied" | "expired" = "approved";
  #byId = new Map<string, SpendRequest>();
  #n = 0;
  readonly #onCall: (what: string) => void;

  constructor(onCall: (what: string) => void = () => {}) {
    this.#onCall = onCall;
  }

  async spendLimits(): Promise<SpendLimits> {
    this.#onCall("user-info");
    return { currency: "usd", perTransaction: 50_000, daily: 50_000, thirtyDay: 2_000_000 };
  }

  /** The owner's Link wallet in test mode: one default Visa. */
  async paymentMethods(): Promise<PaymentMethod[]> {
    this.#onCall("payment-methods list");
    return [
      { id: "csmrpd_test_visa", brand: "visa", last4: "1881", nickname: null, isDefault: true },
    ];
  }

  async create(input: SpendRequestInput): Promise<SpendRequest> {
    this.#onCall("spend-request create");
    if (input.test !== true) throw new Error("scenario Link wallet runs in test mode only");
    if (input.context.length < 100) throw new Error("context must be at least 100 characters");
    this.requests.push(structuredClone(input));
    this.#n += 1;
    const sr: SpendRequest = {
      id: `lsrq_test${String(this.#n).padStart(4, "0")}`,
      status: "pending_approval",
      amount: input.amount,
      currency: input.currency,
      merchantName: input.merchantName,
      merchantUrl: input.merchantUrl,
      approvalUrl: `https://app.link.com/approve/lsrq_test${String(this.#n).padStart(4, "0")}`,
      card: null,
      requiresAction: null,
    };
    this.#byId.set(sr.id, sr);
    return structuredClone(sr);
  }

  async retrieve(id: string, options: { wait?: boolean } = {}): Promise<SpendRequest> {
    this.#onCall("spend-request retrieve");
    const sr = this.#byId.get(id);
    if (sr === undefined) throw new Error("unknown spend request");
    if (options.wait === true && sr.status === "pending_approval") sr.status = this.decision;
    return structuredClone(sr);
  }

  async revealCard(id: string, outFile: string): Promise<SpendRequest> {
    this.#onCall("spend-request retrieve --include card");
    const sr = this.#byId.get(id);
    if (sr === undefined || sr.status !== "approved") throw new Error("not approved");
    if (existsSync(outFile)) throw new Error("output file exists");
    const card = linkTestCard();
    writeFileSync(
      outFile,
      JSON.stringify({
        card: {
          number: card.number,
          cvc: card.cvc,
          exp_month: card.expMonth,
          exp_year: card.expYear,
          billing_address: { name: "Avery Lin", postal_code: "94110" },
        },
      }),
      { mode: 0o600 },
    );
    sr.card = {
      brand: card.brand,
      last4: card.number.slice(-4),
      expMonth: card.expMonth,
      expYear: card.expYear,
    };
    return structuredClone(sr);
  }

  async cancel(id: string): Promise<SpendRequest> {
    const sr = this.#byId.get(id);
    if (sr === undefined) throw new Error("unknown spend request");
    sr.status = "canceled";
    return structuredClone(sr);
  }

  async report(input: {
    domain: string;
    outcome: ReportOutcome;
    spendRequestId: string;
  }): Promise<void> {
    this.#onCall("report");
    this.reports.push({
      domain: input.domain,
      outcome: input.outcome,
      spendRequestId: input.spendRequestId,
    });
  }
}

export type CheckoutField = "number" | "exp" | "cvc";

const FIELDS: Record<CheckoutField, FocusedElement> = {
  number: {
    tagName: "input",
    type: "tel",
    autocomplete: "cc-number",
    frameOrigin: "",
    fieldName: "cardnumber",
  },
  exp: {
    tagName: "input",
    type: "text",
    autocomplete: "cc-exp",
    frameOrigin: "",
    fieldName: "exp-date",
  },
  cvc: { tagName: "input", type: "tel", autocomplete: "cc-csc", frameOrigin: "", fieldName: "cvc" },
};

/**
 * A merchant's card form at `checkoutUrl`, as the browser fill core sees it over CDP: top frame,
 * one focused input at a time, `Input.insertText` lands in the focused field. `submit()` places
 * the order when the typed card is the issued test card (the merchant charges it in Link test
 * mode) and returns the order number; `typedValues()` stays inside the runner.
 */
export class FixtureCheckout implements CdpSession {
  readonly origin: string;
  readonly #url: string;
  #focused: CheckoutField | null = null;
  readonly #values: Record<CheckoutField, string> = { number: "", exp: "", cvc: "" };
  readonly orders: string[] = [];
  readonly #orderPrefix: string;

  constructor(checkoutUrl: string, orderPrefix = "SB") {
    this.#url = checkoutUrl;
    this.origin = new URL(checkoutUrl).origin;
    this.#orderPrefix = orderPrefix;
  }

  focus(field: CheckoutField): void {
    this.#focused = field;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case "Page.getFrameTree":
        return {
          frameTree: { frame: { id: "F_checkout", url: this.#url, securityOrigin: this.origin } },
        };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate":
        return {
          result:
            this.#focused === null ? { subtype: "null" } : { objectId: `obj_${this.#focused}` },
        };
      case "Runtime.callFunctionOn": {
        const fn = String(params.functionDeclaration);
        const f = this.#focused;
        if (f === null) return { result: {} };
        if (fn.includes("isConnected")) return { result: { value: true } };
        if (fn.includes("formHasPassword"))
          return { result: { value: { ...FIELDS[f], frameOrigin: this.origin } } };
        if (fn.includes("activeElement === this"))
          return { result: { value: [...this.#values[f]].length } };
        if (fn.includes('this.value = ""')) this.#values[f] = "";
        return { result: {} };
      }
      case "Input.insertText":
        if (this.#focused !== null) this.#values[this.#focused] += String(params.text ?? "");
        return {};
      case "Input.dispatchKeyEvent":
        if (params.key === "Backspace" && params.type === "keyDown" && this.#focused !== null) {
          this.#values[this.#focused] = "";
        }
        return {};
      default:
        return {};
    }
  }

  /** Place the order with the typed card; `null` when it is not the issued test card. */
  submit(): string | null {
    const card = linkTestCard();
    const exp = `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`;
    if (
      this.#values.number !== card.number ||
      this.#values.exp !== exp ||
      this.#values.cvc !== card.cvc
    ) {
      return null;
    }
    const order = `${this.#orderPrefix}-${String(1000 + this.orders.length + 1)}`;
    this.orders.push(order);
    // The page forgets the card once the order is placed.
    this.#values.number = "";
    this.#values.cvc = "";
    return order;
  }
}
