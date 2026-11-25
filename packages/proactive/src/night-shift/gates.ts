/**
 * Power, thermal and idle gates (docs/design/night-shift-2026.md §4.3). They judge the machine as
 * `readSystemState()` reports it (the same reader the memory pass uses) and never change it: Night
 * shift does not wake the Mac, does not call `pmset` and takes no new power assertion.
 */

/** The part of `SystemState` (`@psyche/memory`) the gates read. */
export interface GateState {
  onAc: boolean;
  batteryPct?: number;
  lowPowerMode: boolean;
  thermal: "nominal" | "fair" | "serious" | "critical";
  idleMinutes: number;
}

/** Why a night did not start or stopped; stored on the night row (`stop_reason`). */
export type GateReason =
  | "battery"
  | "low_power"
  | "thermal"
  | "not_idle"
  | "owner_active"
  | "battery_low";

export const START_IDLE_MINUTES = 10;
/** Below this the owner is at the keyboard: pause until idle again. */
export const ACTIVE_IDLE_MINUTES = 2;
export const START_BATTERY_PCT = 50;
export const STOP_BATTERY_PCT = 30;

export type Gate = { ok: true } | { ok: false; reason: GateReason };

/**
 * Start: on AC, or battery at least 50% and not in Low Power Mode; thermal nominal or fair; owner
 * idle at least 10 minutes. A battery the reader could not measure is not enough (fail closed).
 */
export function startGate(s: GateState): Gate {
  if (!s.onAc) {
    if (s.lowPowerMode) return { ok: false, reason: "low_power" };
    if (s.batteryPct === undefined || s.batteryPct < START_BATTERY_PCT) {
      return { ok: false, reason: "battery" };
    }
  }
  if (s.thermal !== "nominal" && s.thermal !== "fair") return { ok: false, reason: "thermal" };
  if (s.idleMinutes < START_IDLE_MINUTES) return { ok: false, reason: "not_idle" };
  return { ok: true };
}

/**
 * Between jobs, stop when the battery is below 30% (on battery: on AC it is charging), Low Power
 * Mode is on, or thermal is serious or worse.
 */
export function betweenJobsGate(s: GateState): Gate {
  if (s.lowPowerMode) return { ok: false, reason: "low_power" };
  if (!s.onAc && (s.batteryPct === undefined || s.batteryPct < STOP_BATTERY_PCT)) {
    return { ok: false, reason: "battery_low" };
  }
  if (s.thermal !== "nominal" && s.thermal !== "fair") return { ok: false, reason: "thermal" };
  return { ok: true };
}

/** The owner is using the Mac (idle under 2 minutes): pause until idle again, inside the window. */
export const ownerActive = (s: GateState): boolean => s.idleMinutes < ACTIVE_IDLE_MINUTES;
