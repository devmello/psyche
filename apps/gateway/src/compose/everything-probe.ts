import { execFile } from "node:child_process";
import { freemem } from "node:os";
import type { SystemState } from "@psyche/memory";

/**
 * The machine as the everything-memory gates see it (docs/design/everything-memory-2026.md §6.1,
 * decision 10). Read once when the nightly pass starts, from three short-lived system commands on
 * macOS. Anything that cannot be read errs toward "do not run a heavy job" for power and
 * temperature, and toward "idle" for input (the pass only runs inside quiet hours anyway).
 */

export type Exec = (file: string, args: string[]) => Promise<string>;

export const realExec: Exec = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: 3000 }, (_e, out) =>
      resolve(typeof out === "string" ? out : ""),
    ),
  );

/** `pmset -g batt` → AC or battery, and the charge. */
export function parseBattery(out: string): { onAc: boolean; pct?: number } | undefined {
  if (!/Now drawing from/.test(out)) return undefined;
  const onAc = /Now drawing from 'AC Power'/.test(out);
  const pct = /(\d{1,3})%/.exec(out)?.[1];
  return { onAc, ...(pct === undefined ? {} : { pct: Number(pct) }) };
}

/** `pmset -g` → Low Power Mode. */
export const parseLowPower = (out: string): boolean => /^\s*lowpowermode\s+1\s*$/m.test(out);

/** `pmset -g therm` → a CPU speed limit below 100 means the Mac is throttling. */
export function parseThermal(out: string): SystemState["thermal"] {
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out)?.[1];
  if (limit === undefined) return "nominal";
  const n = Number(limit);
  return n >= 100 ? "nominal" : n >= 80 ? "fair" : n >= 50 ? "serious" : "critical";
}

/** `ioreg -c IOHIDSystem` → minutes since the last keyboard or pointer input. */
export function parseIdleMinutes(out: string): number | undefined {
  const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)?.[1];
  return ns === undefined ? undefined : Math.floor(Number(ns) / 1e9 / 60);
}

export async function readSystemState(
  platform: string = process.platform,
  exec: Exec = realExec,
  free: () => number = freemem,
): Promise<SystemState> {
  if (platform !== "darwin") {
    // A server or Linux box: no battery, no HID; the pass runs inside quiet hours only.
    return {
      onAc: true,
      lowPowerMode: false,
      thermal: "nominal",
      idleMinutes: 999,
      freeMemBytes: free(),
    };
  }
  const [batt, settings, therm, hid] = await Promise.all([
    exec("/usr/bin/pmset", ["-g", "batt"]),
    exec("/usr/bin/pmset", ["-g"]),
    exec("/usr/bin/pmset", ["-g", "therm"]),
    exec("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]),
  ]);
  const b = parseBattery(batt);
  return {
    // A failed read means "not sure": not on AC, so the pass waits.
    onAc: b?.onAc ?? false,
    ...(b?.pct === undefined ? {} : { batteryPct: b.pct }),
    lowPowerMode: parseLowPower(settings),
    thermal: parseThermal(therm),
    idleMinutes: parseIdleMinutes(hid) ?? 999,
    freeMemBytes: free(),
  };
}
