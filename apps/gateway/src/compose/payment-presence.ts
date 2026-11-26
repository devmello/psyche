import {
  type ApprovalRequestInput,
  type DecisionResult,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";

/**
 * Payment presence on a headless Linux Host (linux-helper-only design §7.4, R2; B3). The Mac's
 * Touch ID and a Linux desktop's polkit password both need someone at the Host: with no local
 * graphical session polkit refuses (`presence_unavailable_here`). On such a Host a **passkey** is
 * the only verifier for payments, registered from the Psyche app on a remote Mac that dials
 * `gateway.publicOrigin`. Without one
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
 * `PSYCHE_PAYMENT_PRESENCE=passkey` from the **service** environment, read once when the Gateway
 * is composed (the agent cannot set it): payments need a passkey on any Host.
 */
export function passkeyPresenceForced(serviceEnv: NodeJS.ProcessEnv): boolean {
  return serviceEnv.PSYCHE_PAYMENT_PRESENCE?.trim().toLowerCase() === "passkey";
}

export function passkeyRequiredError(): PsycheError {
  return new PsycheError(
    "presence_required",
    "Set up a passkey to approve payments on this Psyche: in the Psyche app on another computer that connects to it at its https address, open Settings → Devices → Add a passkey. Payments can't be approved here without one, so nothing was paid.",
    { details: { reason: "passkey_required" } },
  );
}

export interface PaymentPresenceRule {
  /**
   * This Host approves payments with a passkey only: a headless Linux Host (B0's logind answer),
   * or the service env's switch. Asked on every payment request.
   */
  passkeyOnly(): Promise<boolean>;
  /** At least one active passkey (or a caller-supplied verifier in the passkey role). */
  hasPasskey(): boolean;
}

/** Refuses a payment's card before it is raised when this Host can't verify it (see above). */
export async function checkPaymentPresence(
  input: Pick<ApprovalRequestInput, "kind" | "sideEffect">,
  rule: PaymentPresenceRule,
): Promise<void> {
  if (isPaymentRequest(input) && !rule.hasPasskey() && (await rule.passkeyOnly())) {
    throw passkeyRequiredError();
  }
}

/** How many decided bindings are remembered for their final side-effect class. */
const MAX_DECIDED = 5_000;

/**
 * A broker handle whose `requestApproval` applies `checkPaymentPresence` first, on the class the
 * broker will put on the card: the request's own, raised to the one `decide` gave the same
 * binding (the broker floors a request to its decision's class, so a call the agent declared
 * `write` that the broker decided `financial` is a payment here too; B3 review r1, finding 9).
 */
export function withPaymentPresence<B extends PermissionBroker>(
  broker: B,
  rule: PaymentPresenceRule,
): B {
  const decidedFinancial = new Set<string>();
  const remember = (result: DecisionResult): void => {
    const se = (result as DecisionResult & { sideEffect?: unknown }).sideEffect;
    if (result.bindingHash === undefined) return;
    if (se !== "financial" && result.approvalKind !== "purchase") return;
    decidedFinancial.delete(result.bindingHash);
    decidedFinancial.add(result.bindingHash);
    if (decidedFinancial.size > MAX_DECIDED) {
      const oldest = decidedFinancial.values().next().value;
      if (oldest !== undefined) decidedFinancial.delete(oldest);
    }
  };
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "decide") {
        return async (...args: Parameters<PermissionBroker["decide"]>) => {
          const result = await target.decide(...args);
          remember(result);
          return result;
        };
      }
      if (prop === "requestApproval") {
        return async (input: ApprovalRequestInput) => {
          const floored = decidedFinancial.has(input.bindingHash);
          await checkPaymentPresence(
            floored ? { kind: input.kind, sideEffect: "financial" } : input,
            rule,
          );
          return target.requestApproval(input);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
