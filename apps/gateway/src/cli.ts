import {
  getDevice,
  getPairingRequest,
  listDevices,
  listPairingRequests,
  openDb,
  updateDevice,
} from "@psyche/db";
import { DeviceScope, PsycheError, type DeviceScope as Scope } from "@psyche/protocol";
import { resolveConfig } from "./config.ts";
import { approvePairing } from "./handlers/devices.ts";

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
  if (group !== "devices" || verb === undefined) {
    out(USAGE);
    return group === undefined || group === "help" || group === "--help" ? 0 : 2;
  }
  const config = resolveConfig();
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
