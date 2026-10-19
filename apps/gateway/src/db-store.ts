import { randomInt } from "node:crypto";
import {
  createPairingRequest,
  getDevice,
  getPairingRequest,
  getSetting,
  getSettings,
  insertDevice,
  openDb,
  type PsycheDb,
  setSetting,
  touchLastSeen,
} from "@psyche/db";
import type { Device } from "@psyche/protocol";
import { type GatewayStore, STATE_VERSION_KEY } from "./store.ts";

/** Pairing codes avoid look-alike characters (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function pairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** `GatewayStore` over `@psyche/db` (the only Gateway file that imports it). */
export function openGatewayStore(path: string, now: () => Date): GatewayStore {
  const db: PsycheDb = openDb(path, { now: () => now().toISOString() });
  return {
    getDevice: (id) => getDevice(db, id) ?? null,
    upsertDevice(device: Device) {
      const existing = getDevice(db, device.id);
      if (existing === undefined) {
        insertDevice(db, {
          id: device.id,
          name: device.name,
          platform: device.platform,
          role: device.role,
          publicKey: device.publicKey,
          scopes: device.scopes,
          pairedAt: device.pairedAt ?? null,
        });
        return;
      }
      db.sqlite
        .prepare(
          "UPDATE devices SET name = ?, scopes = ?, paired_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(
          device.name,
          JSON.stringify(device.scopes),
          device.pairedAt ?? null,
          db.now(),
          device.id,
        );
    },
    touchDevice: (id, at) => {
      touchLastSeen(db, id, at);
    },
    createPairingRequest: (input) =>
      createPairingRequest(db, {
        kind: "device",
        code: pairingCode(),
        deviceId: input.deviceId,
        display: input.display,
        expiresAt: input.expiresAt,
      }),
    findPendingPairingForDevice(deviceId, nowIso) {
      const row = db.sqlite
        .prepare(
          "SELECT id FROM pairing_requests WHERE device_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(deviceId, nowIso) as { id: string } | undefined;
      return row === undefined ? null : (getPairingRequest(db, row.id) ?? null);
    },
    expirePendingPairingsForDevice(deviceId, nowIso) {
      db.sqlite
        .prepare(
          "UPDATE pairing_requests SET status = 'expired', decided_at = ?, updated_at = ? WHERE device_id = ? AND status = 'pending'",
        )
        .run(nowIso, nowIso, deviceId);
    },
    countPendingPairings(nowIso) {
      const row = db.sqlite
        .prepare(
          "SELECT count(*) AS n FROM pairing_requests WHERE status = 'pending' AND expires_at > ?",
        )
        .get(nowIso) as { n: number };
      return row.n;
    },
    getSettings: (keys) => getSettings(db, keys),
    setSetting: (key, value) => setSetting(db, key, value),
    transaction: (fn) => db.sqlite.transaction(fn)(),
    readStateVersion() {
      const value = getSetting(db, STATE_VERSION_KEY)?.value;
      return typeof value === "number" && Number.isInteger(value) ? value : 0;
    },
    writeStateVersion: (v) => {
      setSetting(db, STATE_VERSION_KEY, v);
    },
    close: () => db.close(),
  };
}
