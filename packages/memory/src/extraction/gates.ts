import type { EverythingMemorySettings } from "@psyche/protocol";

/**
 * When the nightly pass may run (docs/design/everything-memory-2026.md §6.1, decisions 1 and 10).
 * Pure: the Gateway reads the machine (power, thermal, idle, free memory) and hands the numbers
 * in, so tests need no hardware and nothing here starts a model. A local model never loads
 * unless the owner confirmed it, and never when free memory is short (§6.6).
 */

export interface SystemState {
  onAc: boolean;
  /** 0-100; absent on a desktop. */
  batteryPct?: number;
  lowPowerMode: boolean;
  thermal: "nominal" | "fair" | "serious" | "critical";
  /** Minutes since the last keyboard or pointer input. */
  idleMinutes: number;
  freeMemBytes?: number;
}

export type GateReason =
  | "disabled"
  | "no_sources"
  | "model_none"
  | "battery"
  | "low_power"
  | "thermal"
  | "not_idle"
  | "outside_quiet_hours"
  | "local_not_confirmed"
  | "low_memory";

export type GateResult = { ok: true } | { ok: false; reason: GateReason };

export interface GateInput {
  settings: EverythingMemorySettings;
  state: SystemState;
  /** Minutes since local midnight in the owner's time zone. */
  localMinutes: number;
  /** The owner confirmed the local-model RAM warning for the model now configured. */
  localModelConfirmed: boolean;
  /** Expected resident size of the local model, for the free-memory check. */
  localModelBytes?: number;
  /** "Run now": skips the quiet-hours and idle checks, nothing else. */
  manual?: boolean;
}

const BATTERY_FLOOR = 50;
const IDLE_MINUTES = 10;
const GIB = 1024 ** 3;

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since local midnight for `at` in `timeZone`. */
export function localMinutesAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export function inQuietHours(localMinutes: number, start: string, end: string): boolean {
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return true;
  return s < e ? localMinutes >= s && localMinutes < e : localMinutes >= s || localMinutes < e;
}

export function modelKindsInUse(settings: EverythingMemorySettings): Set<"cloud" | "local"> {
  const out = new Set<"cloud" | "local">();
  const consider = (k: string) => {
    if (k === "cloud" || k === "local") out.add(k);
  };
  const enabled = Object.entries(settings.sources)
    .filter(([, on]) => on)
    .map(([s]) => s);
  for (const s of enabled) {
    const per = (settings.model.perSource as Record<string, { kind: string }> | undefined)?.[s];
    consider((per ?? settings.model.default).kind);
  }
  return out;
}

export function checkGates(input: GateInput): GateResult {
  const { settings, state } = input;
  const no = (reason: GateReason): GateResult => ({ ok: false, reason });
  if (!settings.enabled) return no("disabled");
  if (!Object.values(settings.sources).some(Boolean)) return no("no_sources");
  const kinds = modelKindsInUse(settings);
  if (kinds.size === 0) return no("model_none");
  if (kinds.has("local")) {
    if (!input.localModelConfirmed) return no("local_not_confirmed");
    if (
      input.localModelBytes !== undefined &&
      state.freeMemBytes !== undefined &&
      state.freeMemBytes < input.localModelBytes + 1.5 * GIB
    ) {
      return no("low_memory");
    }
  }
  const battery =
    state.onAc || (settings.schedule.runOnBattery && (state.batteryPct ?? 0) >= BATTERY_FLOOR);
  if (!battery) return no("battery");
  if (state.lowPowerMode) return no("low_power");
  if (state.thermal === "serious" || state.thermal === "critical") return no("thermal");
  if (input.manual !== true) {
    if (state.idleMinutes < IDLE_MINUTES) return no("not_idle");
    if (
      !inQuietHours(
        input.localMinutes,
        settings.schedule.quietHoursStart,
        settings.schedule.quietHoursEnd,
      )
    ) {
      return no("outside_quiet_hours");
    }
  }
  return { ok: true };
}
