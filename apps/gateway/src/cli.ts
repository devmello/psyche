import {
  getDevice,
  getPairingRequest,
  listDevices,
  listPairingRequests,
  openDb,
  probeMigrations,
  updateDevice,
} from "@psyche/db";
import { DeviceScope, PsycheError, type DeviceScope as Scope } from "@psyche/protocol";
import { resolveConfig } from "./config.ts";
import { approvePairing } from "./handlers/devices.ts";
import { loadOrCreateGatewayIdentity, rotateGatewayIdentity } from "./identity.ts";
import { resetPresenceEnrollment } from "./presence-gate.ts";

/**
 * These commands open the database directly, and opening it applies pending migrations. That
 * step belongs to the Gateway's own start, which makes the safety copy first and can undo a
 * failed migration (`pre-update.ts`); a command-line tool must never be the one that migrates the
 * owner's data without it. When the data is not up to date (or cannot be read), say so and stop.
 */
export function refusesToMigrate(dbPath: string, out: (line: string) => void): boolean {
  if (probeMigrations(dbPath).state === "none") return false;
  out(
    "this data needs an update first: start Psyche (or psyched) once so it can make a safety copy and update it, then run this again",
  );
  return true;
}

const SCOPES = (DeviceScope as unknown as { enum: Scope[] }).enum;

function parseScopes(raw: string | undefined): Scope[] {
  const scopes = (raw ?? "operator.read,operator.write,operator.approvals,operator.admin")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of scopes) {
    if (!SCOPES.includes(s as Scope)) throw new PsycheError("invalid_params", `unknown scope ${s}`);
  }
  return scopes as Scope[];
}

const USAGE = `usage:
  psyched                                   run the Gateway
  psyched devices list                      paired devices and pending pairing requests
  psyched devices approve <code> [scopes]   approve the pending request showing <code>
  psyched devices grant <deviceId> <scopes> set a paired device's scopes
  psyched identity show                     the Gateway's identity key fingerprint (what a new
                                            computer shows next to its pairing code)
  psyched identity rotate                   make a new identity key: every computer that pinned the
                                            old one stops with "identity changed" and must pair
                                            again; restart psyched afterwards
  psyched presence reset                    after losing every passkey and helper key: let
                                            security changes run on operator.admin until a new
                                            one is registered (they fail presence_required now)
scopes: comma-separated; default for approve is every operator scope (the owner's first device)`;

/**
 * Local owner commands that work on the database directly. They bootstrap the first
 * `operator.admin` device: the handshake secret never grants admin (S23 review PR-1-A), so the
 * owner approves it here, on the machine, or from an existing admin device. A connected device
 * picks up new scopes when it reconnects.
 */
export function runCli(
  argv: string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): number {
  const [group, verb, a, b] = argv;
  if (group === "presence" && verb === "reset") {
    if (refusesToMigrate(resolveConfig().dbPath, out)) return 1;
    const db = openDb(resolveConfig().dbPath);
    try {
      const had = resetPresenceEnrollment(db);
      out(
        had
          ? "presence enrollment cleared: register a passkey or the helper's key again; restart psyched if it is running"
          : "presence was not enrolled; nothing to reset",
      );
      return 0;
    } finally {
      db.close();
    }
  }
  if (group === "identity" && (verb === "show" || verb === "rotate")) {
    const home = resolveConfig().home;
    const identity =
      verb === "rotate" ? rotateGatewayIdentity(home) : loadOrCreateGatewayIdentity(home);
    out(identity.fingerprint);
    if (verb === "rotate") {
      out(
        "identity rotated: restart psyched, then pair each computer again (they refuse the new key until you forget and pair again)",
      );
    }
    return 0;
  }
  if (group !== "devices" || verb === undefined) {
    out(USAGE);
    return group === undefined || group === "help" || group === "--help" ? 0 : 2;
  }
  const config = resolveConfig();
  if (refusesToMigrate(config.dbPath, out)) return 1;
  const db = openDb(config.dbPath);
  try {
    if (verb === "list") {
      for (const d of listDevices(db)) {
        out(
          `${d.id}  ${d.name}  ${d.platform}/${d.role}  ${d.pairedAt ? d.scopes.join(",") : "unpaired"}`,
        );
      }
      for (const r of listPairingRequests(db, { status: "pending" })) {
        out(
          `pending ${r.code}  ${r.display}  key ${r.publicKeyFingerprint ?? "?"}  via ${r.transport ?? "?"} ${r.remoteAddress ?? ""}`,
        );
      }
      return 0;
    }
    if (verb === "approve" && a) {
      const code = a.toUpperCase();
      const request = listPairingRequests(db, { status: "pending" }).find((r) => r.code === code);
      if (!request)
        throw new PsycheError("not_found", `no pending pairing request with code ${code}`);
      const { device } = db.sqlite.transaction(() =>
        approvePairing(db, {
          pairingRequestId: request.id,
          scopes: parseScopes(b),
          code,
          decidedByDeviceId: null,
        }),
      )();
      out(
        `approved ${device.name} (${device.id}) with ${device.scopes.join(",")}; reconnect it to apply`,
      );
      return getPairingRequest(db, request.id)?.status === "approved" ? 0 : 1;
    }
    if (verb === "grant" && a && b) {
      const device = getDevice(db, a);
      if (!device?.pairedAt || device.revokedAt)
        throw new PsycheError("not_found", `no paired device ${a}`);
      const updated = updateDevice(db, a, { scopes: parseScopes(b) });
      out(`${a} now has ${updated?.scopes.join(",")}; reconnect it to apply`);
      return 0;
    }
    out(USAGE);
    return 2;
  } catch (err) {
    out(`error: ${PsycheError.from(err).message}`);
    return 1;
  } finally {
    db.close();
  }
}
