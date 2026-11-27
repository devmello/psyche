import type { PsycheDb } from "@psyche/db";
import { type PairingRequest, PsycheError } from "@psyche/protocol";
import { stateSealFor } from "./state-seal.ts";

/**
 * What a device pairing request was when the Gateway made it, kept in memory.
 *
 * `pairing_requests` is not sealed: any program running as the owner can rewrite a pending row
 * (its device, key fingerprint, code, purpose, expiry) and so point the owner's code at another
 * device. The Gateway knows the true binding at the one place it creates a request (`auth.ts`,
 * from the hello's own device id and key). Every path that pairs from a request (the card's
 * `devices.approve`, `psyched devices approve`, the first-admin shortcut) refuses a row that differs
 * from this entry or has none. After a restart the map is empty, so an older request is refused:
 * the device connects again and gets a fresh code.
 */

interface Binding {
  code: string;
  deviceId: string;
  fingerprint: string;
  purpose: "device" | "machine";
  expiresAt: string;
}

/** Far above any pending-pairing cap: a backstop against growth, never reached in practice. */
const MAX_BINDINGS = 1000;

const BINDINGS = new WeakMap<PsycheDb["sqlite"], Map<string, Binding>>();

function mapOf(db: PsycheDb): Map<string, Binding> {
  let m = BINDINGS.get(db.sqlite);
  if (m === undefined) {
    m = new Map();
    BINDINGS.set(db.sqlite, m);
  }
  return m;
}

/** At creation, from what the Gateway itself wrote (never from a row read back later). */
export function rememberPairingBinding(db: PsycheDb, request: PairingRequest, nowMs: number): void {
  if (request.kind !== "device" || !request.deviceId || !request.publicKeyFingerprint) return;
  const m = mapOf(db);
  for (const [id, b] of m) {
    if (Date.parse(b.expiresAt) <= nowMs) m.delete(id);
  }
  while (m.size >= MAX_BINDINGS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
  m.set(request.id, {
    code: request.code,
    deviceId: request.deviceId,
    fingerprint: request.publicKeyFingerprint,
    purpose: request.purpose === "machine" ? "machine" : "device",
    expiresAt: request.expiresAt,
  });
}

/** The request was decided (approved or denied): its entry goes. */
export function forgetPairingBinding(db: PsycheDb, requestId: string): void {
  BINDINGS.get(db.sqlite)?.delete(requestId);
}

/** The stored row is exactly the request this Gateway made: same device, key, code, purpose, expiry. */
export function pairingRequestBound(db: PsycheDb, request: PairingRequest): boolean {
  const b = BINDINGS.get(db.sqlite)?.get(request.id);
  return (
    b !== undefined &&
    request.kind === "device" &&
    request.deviceId === b.deviceId &&
    request.publicKeyFingerprint === b.fingerprint &&
    request.code === b.code &&
    (request.purpose === "machine" ? "machine" : "device") === b.purpose &&
    request.expiresAt === b.expiresAt
  );
}

/**
 * Refuses a pairing request this Gateway did not make as it now reads. A row that has an entry
 * but differs from it was rewritten outside Psyche: an alert on every device. A row with no entry
 * is most often from before a restart, so that one is only refused.
 */
export function assertPairingRequestBound(db: PsycheDb, request: PairingRequest): void {
  if (pairingRequestBound(db, request)) return;
  const tampered = BINDINGS.get(db.sqlite)?.has(request.id) === true;
  if (tampered) {
    const raise = () => {
      try {
        stateSealFor(db)?.alerts.add("state_changed_outside", {
          changes: [{ table: "pairing_requests", change: "modified" }],
          reason: "pairing_request_changed",
        });
      } catch {
        // the refusal below stands either way
      }
    };
    // Inside a transaction the alert would roll back with the refused call: write it after.
    if (db.sqlite.inTransaction) queueMicrotask(raise);
    else raise();
  }
  throw new PsycheError(
    "conflict",
    tampered
      ? "That pairing request was changed outside Psyche; ask the device to connect again for a new code"
      : "That pairing request is from before Psyche restarted; ask the device to connect again for a new code",
  );
}
