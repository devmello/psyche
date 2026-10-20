import type { LinkPaymentMethod, VaultPayment } from "@psyche/protocol";
import { CreditCard } from "lucide-react";
import type { ReactElement } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { formatRelative } from "../../lib/format.ts";
import { EmptyNotice, Group, LoadGate, type LoadProps } from "./shared.tsx";

/**
 * Settings → Credentials → Payments (G12, security §4.9): the owner's Stripe Link payment methods
 * and recent spends with their hold / charge / refund state. Brand and last4 only; card numbers
 * never reach Psyche, and every purchase is approved on a device first.
 */

export interface PaymentsView extends LoadProps {
  /** False when Stripe Link is not set up on the Gateway (`payments_not_configured`). */
  configured: boolean;
  methods: readonly LinkPaymentMethod[];
  payments: readonly VaultPayment[];
}

const BRAND: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  bank_account: "Bank account",
  link_balance: "Link balance",
};

export function brandLabel(brand: string): string {
  return BRAND[brand.toLowerCase()] ?? brand;
}

/** `Visa •••• 1881`; a Link balance has no last4. */
export function maskedCard(card: { brand: string; last4: string }): string {
  const brand = brandLabel(card.brand);
  return card.last4 === "" ? brand : `${brand} •••• ${card.last4}`;
}

/** Minor units → `$35.00`, `¥500`, with the currency's own exponent. */
export function formatMinor(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const f = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    return f.format(amount / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

const STATE_LABEL: Record<VaultPayment["payment"]["state"], string> = {
  none: "",
  held: "held",
  captured: "charged",
  partially_refunded: "partly refunded",
  refunded: "refunded",
  declined: "declined",
  released: "hold released",
};

const STATUS_LABEL: Record<string, string> = {
  created: "created",
  pending_approval: "waiting for approval in Link",
  approved: "approved",
  succeeded: "paid",
  failed: "failed",
  denied: "denied in Link",
  expired: "expired",
  canceled: "canceled",
};

/** The merchant's side when there is one (held, charged, refunded), else Link's status. */
export function paymentStateLabel(p: VaultPayment): string {
  if (p.payment.state !== "none") return STATE_LABEL[p.payment.state];
  return STATUS_LABEL[p.status] ?? p.status.replaceAll("_", " ");
}

type BadgeVariant = "muted" | "approval" | "success" | "danger" | "info";

function stateVariant(p: VaultPayment): BadgeVariant {
  switch (p.payment.state) {
    case "held":
      return "approval";
    case "captured":
      return "success";
    case "declined":
      return "danger";
    case "refunded":
    case "partially_refunded":
    case "released":
      return "info";
    default:
      return p.status === "succeeded" || p.status === "approved"
        ? "success"
        : p.status === "pending_approval"
          ? "approval"
          : p.status === "failed" || p.status === "denied"
            ? "danger"
            : "muted";
  }
}

/** Amount with what moved: `$35.00`, `$35.00 · $35.00 refunded`. */
function amountText(p: VaultPayment): string {
  const total = formatMinor(p.amount, p.currency);
  return p.payment.refunded > 0
    ? `${total} · ${formatMinor(p.payment.refunded, p.currency)} refunded`
    : total;
}

/** The merchant's reference the owner would quote: order number, confirmation or hold. */
function merchantRef(p: VaultPayment): string | null {
  const r = p.refs;
  return r.orderNumber ?? r.merchantConfirmation ?? r.holdRef ?? null;
}

export function PaymentsGroup({
  view,
  now,
  onOpenTask,
}: {
  view: PaymentsView;
  now: number;
  onOpenTask?: (taskId: string) => void;
}): ReactElement {
  return (
    <Group
      title="Payments"
      description="Stripe Link pays with a one-time card after you approve each purchase on a device. Your card numbers never reach Psyche."
    >
      <LoadGate
        label="payments"
        loading={view.loading ?? false}
        error={view.error ?? null}
        rows={2}
        {...(view.onRetry ? { onRetry: view.onRetry } : {})}
      >
        {!view.configured ? (
          <EmptyNotice text="Stripe Link is not set up. Install the Link CLI on the Gateway's machine, sign in to Link, and set PSYCHE_LINK_CLI; Psyche then shows your payment methods here." />
        ) : (
          <>
            {view.methods.length === 0 ? (
              <EmptyNotice text="Your Link wallet has no payment methods. Add one in the Link app." />
            ) : (
              <ul aria-label="Link payment methods" className="flex flex-wrap gap-2">
                {view.methods.map((m) => (
                  <li
                    key={m.id}
                    className="inline-flex items-center gap-2 rounded-md border border-gray-6 px-2.5 py-1.5"
                  >
                    <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>{maskedCard(m)}</span>
                    {m.nickname ? (
                      <span className="text-xs text-muted-foreground">{m.nickname}</span>
                    ) : null}
                    {m.isDefault ? <Badge variant="muted">default</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
            {view.payments.length === 0 ? (
              <EmptyNotice text="No purchases yet." />
            ) : (
              <Table aria-label="Recent payments">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Merchant</TableHead>
                    <TableHead scope="col">Amount</TableHead>
                    <TableHead scope="col">Paid with</TableHead>
                    <TableHead scope="col">State</TableHead>
                    <TableHead scope="col">When</TableHead>
                    {onOpenTask ? (
                      <TableHead scope="col">
                        <span className="sr-only">Task</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.payments.map((p) => {
                    const ref = merchantRef(p);
                    const source = p.fundingSource ?? p.card;
                    return (
                      <TableRow key={p.spendRequestId}>
                        <TableCell>
                          <span className="font-medium">{p.merchantName}</span>
                          <span className="block text-xs text-muted-foreground">
                            {p.merchantHost}
                            {ref ? ` · ${ref}` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="tabular-nums">{amountText(p)}</TableCell>
                        <TableCell>{source ? maskedCard(source) : "Stripe Link"}</TableCell>
                        <TableCell>
                          <Badge variant={stateVariant(p)}>{paymentStateLabel(p)}</Badge>
                        </TableCell>
                        <TableCell>{formatRelative(p.createdAt, now)}</TableCell>
                        {onOpenTask ? (
                          <TableCell className="text-right">
                            {p.taskId ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => onOpenTask(p.taskId as string)}
                              >
                                Open task
                              </Button>
                            ) : null}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </LoadGate>
    </Group>
  );
}
