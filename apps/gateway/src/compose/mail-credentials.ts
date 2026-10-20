import type { ApproveMailCredential, ConnectorRegistry } from "@psyche/connectors";
import { mailCredentialTarget } from "@psyche/connectors";
import { PLACEHOLDER_PATTERN, PsycheError } from "@psyche/protocol";
import type { ComposeServices } from "./services.ts";

/**
 * Credential approvals for the mail connectors (IMAP / JMAP, feature M7) and the email channel
 * (N9). The connector reads its app password or token from the vault (executor `connector`,
 * target `account: <connectorId>`), which needs an approved `credential_fill`:
 *
 * - one card per mailbox credential, offering "for this account" (`site`); a site-scoped approval
 *   is reused while its grant is live (the broker re-verifies it), a `once` one is used once;
 * - an owner-present purpose (`connect`, `tool`) waits for the answer; background `sync` and
 *   `health` (and the email channel's polls) never block: they leave one pending card and fail
 *   `approval_required` until it is answered.
 */
export interface MailCredentials {
  approve: ApproveMailCredential;
  /** The email channel's password source for a connected mail connector (`SecretSource`). */
  secret(connectorId: string): { use<T>(fn: (value: string) => Promise<T>): Promise<T> };
}

const placeholderOnly = new RegExp(`^${PLACEHOLDER_PATTERN.source}$`);

export function mailCredentials(
  services: ComposeServices,
  registry: () => ConnectorRegistry,
): MailCredentials {
  /** `<connectorId>|<placeholder>` → the approval to reuse or wait for. */
  const known = new Map<string, string>();

  const usable = async (id: string): Promise<"yes" | "pending" | "no"> => {
    const a = await services.rawBroker.get(id);
    if (a === undefined) return "no";
    if (a.status === "pending") return "pending";
    if (a.status !== "approved" || a.scopeGranted !== "site") return "no";
    // A live site grant verifies without being consumed; a revoked one does not.
    const v = await services.rawBroker.verifyBinding(id, a.bindingHash);
    return v.ok ? "yes" : "no";
  };

  const approve: ApproveMailCredential = async (req, run) => {
    const key = `${req.connectorId}|${req.placeholder}`;
    const cached = known.get(key);
    if (cached !== undefined) {
      const state = await usable(cached);
      if (state === "yes") return cached;
      if (state === "pending") {
        if (req.purpose === "sync" || req.purpose === "health") {
          throw new PsycheError("approval_required", "the mail credential's card is waiting", {
            details: { approvalId: cached },
          });
        }
        return wait(key, cached, req.purpose);
      }
      known.delete(key);
    }
    const slug = placeholderOnly.exec(req.placeholder)?.[1];
    if (slug === undefined) throw new PsycheError("invalid_params", "not a credential placeholder");
    // The running tool call's loop context (thread, run, task, taint), when there is one.
    const ctx = run === undefined ? undefined : services.calls.get(run.callId);
    const issued = await services.vault.requestFill({
      slug,
      target: req.target.value,
      executor: "connector",
      requestedBy: {
        runId: ctx?.runId ?? null,
        taskId: ctx?.taskId ?? null,
        threadId: ctx?.threadId ?? null,
        ...(run?.callId === undefined ? {} : { toolCallId: run.callId }),
        agent: `connector:${req.connectorId}`,
      },
      taint: ctx?.taint ?? false,
      offerSite: true,
    });
    const id = issued.approval.id;
    known.set(key, id);
    if (req.purpose === "sync" || req.purpose === "health" || ctx?.mode === "unattended") {
      throw new PsycheError("approval_required", "the mail credential needs your approval", {
        details: { approvalId: id },
      });
    }
    return wait(key, id, req.purpose);
  };

  const wait = async (key: string, id: string, _purpose: string): Promise<string> => {
    const done = await services.broker.awaitDecision(id);
    if (done.status !== "approved") {
      known.delete(key);
      throw new PsycheError("policy_denied", `the mail credential's approval was ${done.status}`);
    }
    // A `once` answer serves this call only.
    if (done.scopeGranted !== "site") known.delete(key);
    return id;
  };

  return {
    approve,
    secret(connectorId) {
      return {
        async use(fn) {
          const record = await registry().get(connectorId);
          const cfg = record.config as Record<string, unknown>;
          const placeholder = cfg.password ?? cfg.token;
          if (typeof placeholder !== "string" || !placeholderOnly.test(placeholder)) {
            throw new PsycheError("invalid_params", `${connectorId} has no vault credential`);
          }
          const hosts = [cfg.host, cfg.smtpHost].filter((h): h is string => typeof h === "string");
          const target = mailCredentialTarget(connectorId, hosts);
          const approvalId = await approve({ connectorId, placeholder, target, purpose: "sync" });
          const secret = await services.vault.resolve(placeholder, target, approvalId, {
            executor: "connector",
          });
          try {
            return await secret.use((value) => fn(value));
          } finally {
            secret.dispose();
          }
        },
      };
    },
  };
}
