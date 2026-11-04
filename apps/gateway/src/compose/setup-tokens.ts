import { hostname } from "node:os";
import {
  createSetupToken,
  getDevice,
  listSetupTokens,
  type PsycheDb,
  revokeSetupToken,
} from "@psyche/db";
import {
  type AuditLog,
  type DeviceScope,
  encodePairingLink,
  encodePairingLinkV2,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";

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

/**
 * The hook for a computer that paired itself with a token: audits it, and when the append fails
 * says so in the log (the code only, never the token or the error text) instead of dropping it.
 */
export function setupTokenUsedHook(deps: {
  db: PsycheDb;
  audit: Pick<AuditLog, "append">;
  log?: Logger;
}): (used: { tokenId: string; deviceId: string; scopes: DeviceScope[] }) => void {
  return (used) => {
    const name = getDevice(deps.db, used.deviceId)?.name;
    void auditSetupTokenUse(deps.audit, used, name).catch((err: unknown) => {
      deps.log?.log("warn", "audit append for a setup-token pairing failed", {
        tokenId: used.tokenId,
        code: PsycheError.from(err).code,
      });
    });
  };
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
        params: { scopes: DeviceScope[]; via?: "address" | "lan" },
      ): Promise<MethodResult<"devices.setupToken.create">> {
        const { config, identity } = call.ctx;
        // The link is a secret that pairs a new device. Only the Host's own desktop shell may make
        // one (loopback, no Origin, the per-launch handshake secret): a remote device must never
        // mint a way in, even with admin and presence. With presence off the same rule holds.
        if (
          call.identity.desktopShell !== true ||
          !call.conn.peer.remoteLoopback ||
          call.conn.peer.origin !== null
        ) {
          throw new PsycheError(
            "forbidden",
            "Only Psyche on the Host itself can make a pairing link",
          );
        }
        // Which link, and why. A link for a Tailscale (or other CA-certified) address is v1: the
        // identity key's fingerprint is all the Client needs, because the address's own
        // certificate is checked by the system. A link for this network is v2, and only then:
        // the LAN certificate is self-signed, so the link must carry its SPKI pin and the full
        // identity key, and v2 can name nothing but a local-network address (`lanHostKind`). The
        // owner chooses (`via`); the Host never turns a link into the other kind by itself.
        const hostName = (hostname().trim() || "Psyche").slice(0, 64);
        const lan = params.via === "lan";
        let gatewayUrl: string;
        let certPin: string | null = null;
        let makeLink: (token: string) => string;
        if (lan) {
          // The link names the address and the certificate the Gateway is serving right now, so
          // LAN listening must be running (and not paused on another network).
          const status = call.ctx.lan.status();
          if (
            !status.enabled ||
            status.origin === null ||
            status.certSpki === null ||
            status.listening.length === 0
          ) {
            throw new PsycheError(
              "unavailable",
              "Allow computers on this network first, and make sure it is listening, before making a link for this network",
            );
          }
          gatewayUrl = new URL(status.origin).origin;
          const pin = status.certSpki;
          certPin = pin;
          makeLink = (token) =>
            encodePairingLinkV2({
              gatewayUrl,
              gatewayKey: identity.publicKey,
              certPin: pin,
              setupToken: token,
              hostName,
            });
        } else {
          // The link carries the address other computers reach this Gateway at. Without one
          // there is nothing to put in it, and guessing (a loopback address) would hand out a
          // link that pairs nothing.
          const origin = config.publicOrigin;
          if (origin === null) {
            throw new PsycheError(
              "unavailable",
              "Set gateway.publicOrigin (the Tailscale address of this Mac) before making a pairing link",
            );
          }
          gatewayUrl = new URL(origin).origin;
          makeLink = (token) =>
            encodePairingLink({
              gatewayUrl,
              gatewayFingerprint: identity.fingerprint,
              setupToken: token,
              hostName,
            });
        }
        // Everything the link needs is checked before a token row exists, so a failure leaves
        // no live token behind.
        try {
          makeLink(`pst_${"A".repeat(43)}`);
        } catch {
          throw new PsycheError(
            "unavailable",
            lan
              ? "This Mac's network address or name cannot go in a pairing link"
              : "This Mac's address or name cannot go in a pairing link; check gateway.publicOrigin",
          );
        }
        const { token, record } = createSetupToken(db, {
          scopes: params.scopes,
          createdByDeviceId: call.identity.deviceId,
          certPin,
        });
        const link = makeLink(token);
        try {
          await audit.append({
            kind: SETUP_TOKEN_CREATED_AUDIT_KIND,
            actor: { type: "device", deviceId: call.identity.deviceId },
            data: {
              tokenId: record.id,
              scopes: record.scopes,
              expiresAt: record.expiresAt,
              linkVersion: lan ? 2 : 1,
            },
          });
        } catch (err) {
          // A way in nobody can audit is not handed out: the link is withheld, so the token that
          // belongs to it is revoked rather than left live and unknown to the owner.
          revokeSetupToken(db, record.id);
          call.ctx.log.log("warn", "audit append for a new setup token failed; token revoked", {
            tokenId: record.id,
            code: PsycheError.from(err).code,
          });
          throw new PsycheError("unavailable", "The pairing link could not be recorded; try again");
        }
        return {
          setupToken: record,
          link,
          version: lan ? 2 : 1,
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
