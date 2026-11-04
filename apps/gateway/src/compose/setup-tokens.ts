import { hostname } from "node:os";
import { createSetupToken, listSetupTokens, type PsycheDb, revokeSetupToken } from "@psyche/db";
import {
  type AuditLog,
  type DeviceScope,
  encodePairingLink,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Setup tokens and pairing links on the Host (remote-gateway design §3.4). Settings → Server &
 * remote access → "Pair another computer" makes a single-use, ten-minute token and the
 * `psyche-pair:v1` link that carries it. A computer that connects with the token pairs at once with
 * the scopes the owner chose here (`auth.ts` spends it). The owner is the one who decides, so
 * making a token is a security change: it needs `operator.admin` and fresh presence (the
 * presence gate), exactly like approving a pairing request. Revoking only narrows, so it needs
 * admin alone.
 */

export const SETUP_TOKEN_CREATED_AUDIT_KIND = "device.setup_token.created";
export const SETUP_TOKEN_REVOKED_AUDIT_KIND = "device.setup_token.revoked";

/** Audits a computer that paired itself with a token (`device.paired`; the token id, not the token). */
export function auditSetupTokenUse(
  audit: Pick<AuditLog, "append">,
  used: { tokenId: string; deviceId: string; scopes: DeviceScope[] },
  name: string | undefined,
): Promise<unknown> {
  return audit.append({
    kind: "device.paired",
    actor: { type: "device", deviceId: used.deviceId },
    data: {
      deviceId: used.deviceId,
      ...(name === undefined ? {} : { name }),
      scopes: used.scopes,
      via: "setup_token",
      tokenId: used.tokenId,
    },
  });
}

export function setupTokenHandlers(deps: {
  db: PsycheDb;
  audit: Pick<AuditLog, "append">;
}): Record<string, HandlerDef> {
  const { db, audit } = deps;
  return {
    "devices.setupToken.create": {
      async run(
        call: Call,
        params: { scopes: DeviceScope[] },
      ): Promise<MethodResult<"devices.setupToken.create">> {
        const { config, identity } = call.ctx;
        // The link carries the address other computers reach this Gateway at. Without one there
        // is nothing to put in it, and guessing (a loopback address) would hand out a link that
        // pairs nothing.
        const origin = config.publicOrigin;
        if (origin === null) {
          throw new PsycheError(
            "unavailable",
            "Set gateway.publicOrigin (the Tailscale address of this Mac) before making a pairing link",
          );
        }
        const { token, record } = createSetupToken(db, {
          scopes: params.scopes,
          createdByDeviceId: call.identity.deviceId,
        });
        const hostName = hostname();
        const gatewayUrl = new URL(origin).origin;
        const link = encodePairingLink({
          gatewayUrl,
          gatewayFingerprint: identity.fingerprint,
          setupToken: token,
          hostName: hostName.slice(0, 64) || "Psyche",
        });
        await audit.append({
          kind: SETUP_TOKEN_CREATED_AUDIT_KIND,
          actor: { type: "device", deviceId: call.identity.deviceId },
          data: { tokenId: record.id, scopes: record.scopes, expiresAt: record.expiresAt },
        });
        return {
          setupToken: record,
          link,
          gatewayUrl,
          gatewayFingerprint: identity.fingerprint,
          hostName,
        };
      },
    },
    "devices.setupToken.list": {
      run(): MethodResult<"devices.setupToken.list"> {
        return { setupTokens: listSetupTokens(db) };
      },
    },
    "devices.setupToken.revoke": {
      async run(
        call: Call,
        params: { id: string },
      ): Promise<MethodResult<"devices.setupToken.revoke">> {
        const record = revokeSetupToken(db, params.id);
        if (record === undefined) throw new PsycheError("not_found", "That setup token is gone");
        if (record.status === "revoked") {
          await audit.append({
            kind: SETUP_TOKEN_REVOKED_AUDIT_KIND,
            actor: { type: "device", deviceId: call.identity.deviceId },
            data: { tokenId: record.id },
          });
        }
        return { setupToken: record };
      },
    },
  };
}
