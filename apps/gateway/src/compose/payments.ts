import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { createVaultHandlers, LinkCliWallet, type LinkWallet, PaymentBroker } from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Stripe Link payments (S06 G12) in the running Gateway: one `PaymentBroker` over the owner's
 * Link wallet, its `vault.payments.*` handlers (replacing the vault's `unavailable` stubs) and
 * every spend-record change fanned out as `vault.payment.updated`. Without a wallet the part adds
 * nothing and Settings → Credentials shows Stripe Link as not set up.
 *
 * Purchase approvals stay with the Permission Broker (financial, once, device-only); card files
 * live 0600 under `$PSYCHE_HOME/vault/cards/` and `sweep` shreds them past their TTL.
 */

export interface PaymentsSetup {
  /** A ready wallet (tests, the scenario runner). Overrides `linkCli`. */
  wallet?: LinkWallet;
  /** Trusted path to the installed Link CLI (`PSYCHE_LINK_CLI`). */
  linkCli?: string;
  /** Card files are shredded this long after reveal (default 2 h). */
  cardTtlMs?: number;
  /** How often stale card files are swept (default 10 min). */
  sweepMs?: number;
}

const SWEEP_MS = 10 * 60_000;

export interface ComposedPayments extends ComposedPart {
  /** The broker, for the purchase tools that hold, capture and refund through it. */
  readonly payments?: PaymentBroker;
}

export function paymentsSetupFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentsSetup {
  const cli = env.PSYCHE_LINK_CLI?.trim();
  return cli ? { linkCli: cli } : {};
}

export function composePayments(
  setup: PaymentsSetup,
): (services: ComposeServices) => ComposedPayments {
  return (services) => {
    const wallet =
      setup.wallet ??
      (setup.linkCli === undefined
        ? undefined
        : new LinkCliWallet({
            cli: setup.linkCli,
            // The CLI's auth file sits with the vault, not in the owner's home directory.
            env: { LINK_AUTH_FILE: join(services.home, "vault", "link-auth.json") },
          }));
    if (wallet === undefined) return {};
    const payments = new PaymentBroker({
      home: services.home,
      wallet,
      permissions: services.broker,
      redactor: services.redactor,
      audit: services.audit,
      clock: services.clock,
      ...(setup.cardTtlMs === undefined ? {} : { cardTtlMs: setup.cardTtlMs }),
    });
    const all = createVaultHandlers(services.vault, { payments });
    const handlers: Record<string, HandlerDef> = {
      "vault.payments.list": {
        run: (_call: Call, params: never) => all["vault.payments.list"](params),
      },
      "vault.payments.methods": {
        async run(_call: Call, params: never) {
          try {
            return await all["vault.payments.methods"](params);
          } catch (err) {
            if (err instanceof PsycheError) throw err;
            // The CLI's own message may echo account details: report the failure only.
            throw new PsycheError("unavailable", "Stripe Link did not answer", {
              details: { reason: "link_unavailable" },
            });
          }
        },
      },
    };
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sweep = () => {
      try {
        payments.sweep();
      } catch (err) {
        services.logger?.log("warn", "payments.sweep_failed", {
          error: err instanceof Error ? err.name : "error",
        });
      }
    };
    return {
      payments,
      handlers,
      start() {
        unsubscribe = payments.onUpdate((payment) =>
          services.publish("vault.payment.updated", { payment }),
        );
        sweep();
        timer = setInterval(sweep, setup.sweepMs ?? SWEEP_MS);
        timer.unref?.();
      },
      stop() {
        unsubscribe?.();
        if (timer !== undefined) clearInterval(timer);
        sweep();
      },
    };
  };
}
