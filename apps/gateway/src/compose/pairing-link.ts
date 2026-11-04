import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { createSetupToken, hashSetupToken, type PsycheDb, purgeSetupTokens } from "@psyche/db";
import {
  type AuditLog,
  encodePairingLink,
  type MethodResult,
  PsycheError,
  pairingLinkOrigin,
  SETUP_TOKEN_TTL_MS,
} from "@psyche/protocol";
import type { SetupTokenEvent } from "../auth.ts";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Pairing links (remote-gateway design §3.4, security §10). `devices.pairing.createLink` makes a
 * single-use setup token that lasts ten minutes, stores only its SHA-256, and returns it inside a
 * `psyche-pair:v1` link together with the Gateway's address and identity key. The token holds no
 * authority: a connect that presents it gets a pending request marked "expected via pairing
 * link", and the owner still approves the device and chooses its scopes (`devices.approve`,
 * which needs presence once a verifier exists). Creation and every use or refusal are audited.
 */

export const PAIRING_LINK_CREATED_AUDIT_KIND = "pairing_link.created";
export const PAIRING_LINK_USED_AUDIT_KIND = "pairing_link.used";
export const PAIRING_LINK_REFUSED_AUDIT_KIND = "pairing_link.refused";

export function pairingLinkHandlers(deps: {
  db: PsycheDb;
  audit: Pick<AuditLog, "append">;
}): Record<string, HandlerDef> {
  return {
    "devices.pairing.createLink": {
      // The reply holds the token in the clear: it is never written to the idempotency table
      // (which keeps replies for days). A retry with the same key makes a new link, and a new link
      // ends the creator's earlier unused one.
      skipIdempotencyStore: true,
      async run(
        call: Call,
        params: { gatewayUrl?: string },
      ): Promise<MethodResult<"devices.pairing.createLink">> {
        const { config, identity, now } = call.ctx;
        // The address comes from this admin call or the Gateway's own configuration, never from a
        // deep link or a query (CVE-2026-25253 rule), and is validated like a link's address.
        const raw = params.gatewayUrl ?? config.publicOrigin;
        if (raw === null || raw === undefined) {
          throw new PsycheError(
            "invalid_params",
            "This Gateway does not know the address other devices reach it at: set gateway.publicOrigin (Tailscale Serve) or pass gatewayUrl",
          );
        }
        const gatewayUrl = pairingLinkOrigin(raw);
        const nowMs = now().getTime();
        purgeSetupTokens(deps.db, new Date(nowMs).toISOString());
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(now().getTime() + SETUP_TOKEN_TTL_MS).toISOString();
        const tokenId = createSetupToken(deps.db, {
          tokenHash: hashSetupToken(token),
          expiresAt,
          createdByDeviceId: call.identity.deviceId,
        });
        const link = encodePairingLink({
          gatewayUrl,
          gatewayIdentityKey: identity.publicKey,
          setupToken: token,
          hostName: hostname(),
        });
        // Never the token or the link: the audit trail records that one was made, not what it holds.
        await deps.audit.append({
          kind: PAIRING_LINK_CREATED_AUDIT_KIND,
          actor: { type: "device", deviceId: call.identity.deviceId },
          data: { tokenId, gatewayUrl, expiresAt },
        });
        return { link, expiresAt };
      },
    },
  };
}

/** Audit hook for `startGateway({ onSetupToken })`: a token spent or refused at a connect. */
export function auditSetupToken(
  audit: Pick<AuditLog, "append">,
  log?: { log(level: "warn", msg: string, fields?: Record<string, string>): void },
) {
  return (event: SetupTokenEvent, peer: { transport: string; remoteAddress: string }): void => {
    const common = {
      deviceId: event.deviceId,
      transport: peer.transport,
      remoteAddress: peer.remoteAddress,
    };
    void audit
      .append(
        event.status === "used"
          ? {
              kind: PAIRING_LINK_USED_AUDIT_KIND,
              actor: { type: "system" },
              data: { ...common, tokenId: event.tokenId },
            }
          : {
              kind: PAIRING_LINK_REFUSED_AUDIT_KIND,
              actor: { type: "system" },
              data: { ...common, reason: event.reason },
            },
      )
      .catch((err: unknown) => {
        // A lost audit entry must not be silent. Never the token: only what happened to whom.
        log?.log("warn", "pairing link audit entry could not be written", {
          event: event.status,
          deviceId: event.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
}
