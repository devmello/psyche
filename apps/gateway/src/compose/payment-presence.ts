import { type ApprovalRequestInput, type PermissionBroker, PsycheError } from "@psyche/protocol";
import { headlessLinuxHost } from "./headless-host.ts";

/**
 * Payment presence on a headless Linux Host (linux-helper-only design §7.4, R2; B3). The Mac's
 * Touch ID and a Linux desktop's polkit password both need someone at the Host: with no local
 * graphical session polkit refuses (`presence_unavailable_here`). On such a Host a **passkey** is
 * the only verifier for payments, registered from a browser at `gateway.publicOrigin`. Without one
 * a payment never raises a card nobody could answer: the call fails `presence_required`
 * (`details.reason: "passkey_required"`) and says how to set one up. Every other approval stays a
 * plain tap (owner decision 2026-11-09); this rule only looks at payments.
 */

/** A payment, as the broker decides `requiresAuthentication` for it (`broker.ts`). */
export function isPaymentRequest(
  input: Pick<ApprovalRequestInput, "kind" | "sideEffect">,
): boolean {
  return input.sideEffect === "financial" || input.kind === "purchase";
}

/**
 * Whether payments need a passkey here: a headless Linux Host (`headlessLinuxHost`), or
 * `PSYCHE_PAYMENT_PRESENCE=passkey` anywhere. Misjudging a desktop as headless only asks for a
 * passkey (stricter), never less: the other verifiers still need someone at the Host.
 */
export function passkeyOnlyPayments(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.PSYCHE_PAYMENT_PRESENCE?.trim().toLowerCase() === "passkey") return true;
  return headlessLinuxHost(platform, env);
}

export function passkeyRequiredError(): PsycheError {
  return new PsycheError(
    "presence_required",
    "Set up a passkey to approve payments on this Psyche: open Psyche in a browser at its https address, then Settings → Devices → Add a passkey. Payments can't be approved here without one, so nothing was paid.",
    { details: { reason: "passkey_required" } },
  );
}

export interface PaymentPresenceRule {
  /** This Host approves payments with a passkey only. Read on every request. */
  passkeyOnly(): boolean;
  /** At least one active passkey (or a caller-supplied verifier in the passkey role). */
  hasPasskey(): boolean;
}

/** Refuses a payment's card before it is raised when this Host can't verify it (see above). */
export function checkPaymentPresence(
  input: Pick<ApprovalRequestInput, "kind" | "sideEffect">,
  rule: PaymentPresenceRule,
): void {
  if (isPaymentRequest(input) && rule.passkeyOnly() && !rule.hasPasskey()) {
    throw passkeyRequiredError();
  }
}

/** A broker handle whose `requestApproval` applies `checkPaymentPresence` first. */
export function withPaymentPresence<B extends PermissionBroker>(
  broker: B,
  rule: PaymentPresenceRule,
): B {
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "requestApproval") {
        return async (input: ApprovalRequestInput) => {
          checkPaymentPresence(input, rule);
          return target.requestApproval(input);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
