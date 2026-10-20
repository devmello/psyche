import { execFile } from "node:child_process";
import { fail } from "../errors.ts";

/**
 * Stripe Link Agent Wallet, as Psyche uses it (security §4.9, feature G12): spend requests that
 * the owner approves in the Link app or website, returning a one-time virtual card. The model
 * and receipts see only brand / last4 / expiry; the card itself goes to a 0600 file.
 */

export type SpendStatus =
  | "created"
  | "pending_approval"
  | "requires_action"
  | "approved"
  | "submitted"
  | "succeeded"
  | "failed"
  | "denied"
  | "expired"
  | "canceled";

export const SPEND_WAITING: readonly SpendStatus[] = [
  "created",
  "pending_approval",
  "requires_action",
];
export const SPEND_FINAL: readonly SpendStatus[] = [
  "succeeded",
  "failed",
  "denied",
  "expired",
  "canceled",
];

export interface LineItem {
  name: string;
  quantity: number;
  /** Minor units. */
  unitAmount: number;
}

export interface SpendRequestInput {
  /** Minor units of `currency`. */
  amount: number;
  /** ISO 4217, lowercase. */
  currency: string;
  /** Shown to the owner in Link; at least 100 characters. */
  context: string;
  merchantName: string;
  merchantUrl: string;
  lineItems: LineItem[];
  paymentMethodId?: string;
  /** Link test mode (test cards, no charge). */
  test?: boolean;
}

export interface MaskedCard {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface SpendRequest {
  id: string;
  status: SpendStatus;
  amount: number;
  currency: string;
  merchantName: string;
  merchantUrl: string;
  /** Where the owner approves, when Link returns one. */
  approvalUrl: string | null;
  card: MaskedCard | null;
  /** `status_details.requires_action.next_action.resolution`. */
  requiresAction: { type: string; resolution: string } | null;
}

/** The full card as Link writes it to the output file. Lives only there and in memory. */
export interface CardFile {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  name?: string;
  postalCode?: string;
}

/** A Link payment method, redacted: what funds a spend request (cards and bank accounts). */
export interface PaymentMethod {
  /** `csmrpd_…`, passed as `--payment-method-id`. */
  id: string;
  /** `visa`, `mastercard`, `bank_account`, `link_balance`, … */
  brand: string;
  last4: string;
  nickname: string | null;
  isDefault: boolean;
}

export interface SpendLimits {
  currency: string;
  perTransaction: number | null;
  daily: number | null;
  thirtyDay: number | null;
}

export type ReportOutcome = "success" | "blocked" | "abandoned";

/** Port over the Link Agent Wallet. `LinkCliWallet` is the production adapter; tests use a fake. */
export interface LinkWallet {
  spendLimits(): Promise<SpendLimits>;
  /** The owner's saved payment methods (`payment-methods list`), redacted. */
  paymentMethods(): Promise<PaymentMethod[]>;
  /** Create the request and ask the owner to approve it (`--request-approval`). */
  create(input: SpendRequestInput): Promise<SpendRequest>;
  /** With `wait`, block until the status leaves the waiting states (or the CLI times out). */
  retrieve(id: string, options?: { wait?: boolean }): Promise<SpendRequest>;
  /** Write the unmasked card to `outFile` (created 0600 by Link); return the masked request. */
  revealCard(id: string, outFile: string): Promise<SpendRequest>;
  cancel(id: string): Promise<SpendRequest>;
  report(input: {
    domain: string;
    outcome: ReportOutcome;
    spendRequestId: string;
    tags?: string[];
  }): Promise<void>;
}

// --- CLI adapter --------------------------------------------------------------------------------

export interface LinkCliOptions {
  /** Trusted path to the installed CLI's `dist/cli.js` (run with this Node) or its executable. */
  cli: string;
  /** Extra environment for the CLI, e.g. `LINK_AUTH_FILE` under `$PSYCHE_HOME/vault/`. Nothing else is inherited but PATH and HOME. */
  env?: Record<string, string>;
  /** Approval wait: `--interval 2 --max-attempts` (default 900 = 30 minutes). */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  run?: (file: string, args: string[], env: Record<string, string>) => Promise<string>;
}

type Json = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Map the CLI's JSON (snake_case, as in the Link API) onto `SpendRequest`; never keeps card numbers. */
export function parseSpendRequest(raw: unknown): SpendRequest {
  const r = (raw ?? {}) as Json;
  const card = (r.card ?? null) as Json | null;
  const action = ((r.status_details as Json | undefined)?.requires_action as Json | undefined)
    ?.next_action as Json | undefined;
  const id = str(r.id);
  if (!/^lsrq_[A-Za-z0-9]+$/.test(id)) return fail("internal", "Link returned no spend request id");
  return {
    id,
    status: str(r.status) as SpendStatus,
    amount: num(r.amount),
    currency: str(r.currency),
    merchantName: str(r.merchant_name),
    merchantUrl: str(r.merchant_url),
    approvalUrl: str(r.approval_url) || null,
    card:
      card === null
        ? null
        : {
            brand: str(card.brand),
            last4: str(card.last4).slice(-4),
            expMonth: num(card.exp_month),
            expYear: num(card.exp_year),
          },
    requiresAction:
      action === undefined ? null : { type: str(action.type), resolution: str(action.resolution) },
  };
}

/** Map `payment-methods list` JSON (a list, or `{data: [...]}`) onto `PaymentMethod`s. */
export function parsePaymentMethods(raw: unknown): PaymentMethod[] {
  const list = Array.isArray(raw) ? raw : (((raw ?? {}) as Json).data ?? []);
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) => {
    const m = (r ?? {}) as Json;
    const card = (m.card ?? m.bank_account ?? {}) as Json;
    const id = str(m.id);
    if (!/^[A-Za-z0-9_]+$/.test(id)) return [];
    return [
      {
        id,
        brand: str(card.brand) || str(m.type) || "unknown",
        last4: (str(card.last4) || str(m.last4)).slice(-4),
        nickname: str(m.nickname) || null,
        isDefault: m.is_default === true || m.default === true,
      },
    ];
  });
}

/** Parse the 0600 card file Link writes (`--output-file`). */
export function parseCardFile(text: string): CardFile {
  let raw: Json;
  try {
    raw = JSON.parse(text) as Json;
  } catch {
    return fail("internal", "Link card file is not JSON");
  }
  const c = ((raw.card as Json | undefined) ?? raw) as Json;
  const addr = (c.billing_address ?? {}) as Json;
  const out: CardFile = {
    number: str(c.number).replace(/\s+/g, ""),
    cvc: str(c.cvc),
    expMonth: num(c.exp_month),
    expYear: num(c.exp_year),
  };
  if (!/^\d{12,19}$/.test(out.number) || !/^\d{3,4}$/.test(out.cvc)) {
    return fail("internal", "Link card file is incomplete");
  }
  if (str(addr.name)) out.name = str(addr.name);
  if (str(addr.postal_code)) out.postalCode = str(addr.postal_code);
  return out;
}

/**
 * Production adapter: runs the Link CLI (`@stripe/link-cli`, installed by the owner; not a
 * dependency of this package) without a shell, with `--format json`. Card details never pass
 * through stdout: `revealCard` uses `--include card --output-file`, and stdout carries only the
 * masked card. Errors never include CLI output.
 */
export class LinkCliWallet implements LinkWallet {
  readonly #o: LinkCliOptions;

  constructor(options: LinkCliOptions) {
    this.#o = options;
  }

  async #call(args: string[]): Promise<Json> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      ...this.#o.env,
    };
    const [file, argv] = this.#o.cli.endsWith(".js")
      ? [process.execPath, [this.#o.cli, ...args, "--format", "json"]]
      : [this.#o.cli, [...args, "--format", "json"]];
    const run =
      this.#o.run ??
      ((f: string, a: string[], e: Record<string, string>) =>
        new Promise<string>((resolve, reject) => {
          execFile(
            f,
            a,
            { env: e, shell: false, timeout: this.#o.timeoutMs ?? 35 * 60_000, maxBuffer: 1 << 20 },
            (err, stdout) =>
              err === null
                ? resolve(stdout)
                : reject(Object.assign(new Error("link-cli failed"), { exitCode: err.code })),
          );
        }));
    let stdout: string;
    try {
      stdout = await run(file, argv, env);
    } catch (err) {
      return fail("unavailable", `link-cli ${args[0] ?? ""} ${args[1] ?? ""} failed`.trim(), {
        reason: "link_cli_failed",
        exitCode: (err as { exitCode?: unknown }).exitCode ?? null,
      });
    }
    try {
      return JSON.parse(stdout) as Json;
    } catch {
      return fail("internal", "link-cli returned non-JSON output");
    }
  }

  async spendLimits(): Promise<SpendLimits> {
    const r = await this.#call(["user-info", "retrieve"]);
    const l = (r.agent_wallet_spend_limits ?? {}) as Json;
    const val = (v: unknown) =>
      typeof v === "number"
        ? v
        : typeof (v as Json)?.amount === "number"
          ? ((v as Json).amount as number)
          : null;
    return {
      currency: str(l.currency) || str(r.default_spend_request_currency) || "usd",
      perTransaction: val(l.per_transaction),
      daily: val(l.daily),
      thirtyDay: val(l.thirty_day),
    };
  }

  async paymentMethods(): Promise<PaymentMethod[]> {
    return parsePaymentMethods(await this.#call(["payment-methods", "list"]));
  }

  async create(input: SpendRequestInput): Promise<SpendRequest> {
    const args = [
      "spend-request",
      "create",
      "--merchant-name",
      input.merchantName,
      "--merchant-url",
      input.merchantUrl,
      "--context",
      input.context,
      "--amount",
      String(input.amount),
      "--currency",
      input.currency,
      ...input.lineItems.flatMap((li) => [
        "--line-item",
        `name:${li.name.replace(/[,:]/g, " ")},unit_amount:${li.unitAmount},quantity:${li.quantity}`,
      ]),
      "--total",
      `type:total,display_text:Total,amount:${input.amount}`,
      "--request-approval",
    ];
    if (input.paymentMethodId !== undefined)
      args.push("--payment-method-id", input.paymentMethodId);
    if (input.test === true) args.push("--test");
    return parseSpendRequest(await this.#call(args));
  }

  async retrieve(id: string, options: { wait?: boolean } = {}): Promise<SpendRequest> {
    const args = ["spend-request", "retrieve", id];
    if (options.wait === true)
      args.push("--interval", "2", "--max-attempts", String(this.#o.maxAttempts ?? 900));
    return parseSpendRequest(await this.#call(args));
  }

  async revealCard(id: string, outFile: string): Promise<SpendRequest> {
    return parseSpendRequest(
      await this.#call([
        "spend-request",
        "retrieve",
        id,
        "--include",
        "card",
        "--output-file",
        outFile,
      ]),
    );
  }

  async cancel(id: string): Promise<SpendRequest> {
    return parseSpendRequest(await this.#call(["spend-request", "cancel", id]));
  }

  async report(input: {
    domain: string;
    outcome: ReportOutcome;
    spendRequestId: string;
    tags?: string[];
  }): Promise<void> {
    await this.#call([
      "report",
      "--domain",
      input.domain,
      "--outcome",
      input.outcome,
      "--spend-request-id",
      input.spendRequestId,
      ...(input.tags ?? []).flatMap((t) => ["--tag", t]),
    ]);
  }
}
