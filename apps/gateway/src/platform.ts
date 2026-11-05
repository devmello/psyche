import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { system32 } from "@psyche/protocol/platform";

/**
 * The Gateway's OS-specific calls (docs/design/cross-platform-2026.md §4.4 item 2): opening a
 * URL, the power state, the account's name, where the desktop app lives. macOS keeps the tools
 * it always used; Windows gets its own; anything else answers "unknown" the way Linux servers
 * always did. Socket and pipe naming lives in `@psyche/protocol/platform` (shared with the node
 * and the packages).
 */

export type Platform = NodeJS.Platform;

type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

/** Windows PowerShell 5.1 by absolute path (always present; `pwsh` 7 may not be). */
const POWERSHELL = () => system32("WindowsPowerShell", "v1.0", "powershell.exe");

const runFile: Run = (file, args, timeoutMs) =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (_e, out) =>
      resolve(typeof out === "string" ? out : ""),
    ),
  );

/**
 * Opens an https URL in the owner's default browser on this computer: `open` on macOS,
 * `rundll32 url.dll,FileProtocolHandler` on Windows (no shell, so nothing in the URL is ever
 * parsed by `cmd.exe`). Returns false where there is no desktop to open it on (Linux servers).
 */
export function openExternalUrl(
  url: URL,
  platform: Platform = process.platform,
  run: (file: string, args: string[]) => void = (file, args) =>
    void execFile(file, args, { windowsHide: true }, () => undefined),
): boolean {
  if (url.protocol !== "https:") return false;
  if (platform === "darwin") {
    run("open", [url.href]);
    return true;
  }
  if (platform === "win32") {
    run(system32("rundll32.exe"), ["url.dll,FileProtocolHandler", url.href]);
    return true;
  }
  return false;
}

/** What `GetSystemPowerStatus` and `GetLastInputInfo` report on Windows. */
export interface WindowsPower {
  /** On mains power; `undefined` when Windows does not know. */
  onAc: boolean | undefined;
  /** No system battery at all (a desktop PC). */
  noBattery: boolean;
  batteryPct?: number;
  /** Battery saver is on. */
  saver: boolean;
  /** Milliseconds since the last keyboard or pointer input in this session. */
  idleMs?: number;
}

/**
 * One short PowerShell run reading `SYSTEM_POWER_STATUS` (kernel32) and `LASTINPUTINFO` (user32):
 * no WMI, no admin rights. About 0.4 s, so callers cache it.
 */
export const WINDOWS_POWER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -Namespace PsychePower -Name Native -MemberDefinition \'[DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(byte[] s); [DllImport("user32.dll")] public static extern bool GetLastInputInfo(uint[] i);\'',
  "$s=New-Object byte[] 12",
  "[void][PsychePower.Native]::GetSystemPowerStatus($s)",
  "$i=[uint32[]](8,0)",
  "$idle=-1",
  "if([PsychePower.Native]::GetLastInputInfo($i)){$idle=[uint32]([Environment]::TickCount -band 0xFFFFFFFF)-$i[1]}",
  '"ac=$($s[0]) flag=$($s[1]) pct=$($s[2]) saver=$($s[3]) idle=$idle"',
].join(";");

/** Parses the script's one line; `undefined` when it did not run. */
export function parseWindowsPower(out: string): WindowsPower | undefined {
  const m = /ac=(\d+) flag=(\d+) pct=(\d+) saver=(\d+) idle=(-?\d+)/.exec(out);
  if (m === null) return undefined;
  const [ac, flag, pct, saver, idle] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  // ACLineStatus 0 offline, 1 online, 255 unknown; BatteryFlag 128 "no system battery";
  // BatteryLifePercent 255 unknown; SystemStatusFlag 1 battery saver on.
  return {
    onAc: ac === 1 ? true : ac === 0 ? false : undefined,
    noBattery: (flag & 128) !== 0,
    ...(pct <= 100 ? { batteryPct: pct } : {}),
    saver: saver === 1,
    ...(idle >= 0 ? { idleMs: idle } : {}),
  };
}

export async function readWindowsPower(run: Run = runFile): Promise<WindowsPower | undefined> {
  const out = await run(
    POWERSHELL(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_POWER_SCRIPT,
    ],
    10_000,
  );
  return parseWindowsPower(out);
}

export type ThermalLevel = "nominal" | "fair" | "serious" | "critical";

/**
 * How hot Windows says the PC runs, readable without admin rights: the ACPI thermal zones'
 * passive-cooling limit (`Win32_PerfFormattedData_Counters_ThermalZoneInformation`, 100 = no
 * thermal throttling) and the processors' performance limit (`% Performance Limit`, lowered by
 * firmware when hot). `MSAcpi_ThermalZoneTemperature` needs admin, so temperatures are not read.
 * About a second (two CIM queries), so only the nightly memory pass asks.
 */
export const WINDOWS_THERMAL_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$z=@(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object { $_.PercentPassiveLimit })",
  "$p=(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter \"Name='_Total'\").PercentPerformanceLimit",
  "\"passive=$($z -join ',') perf=$p\"",
].join(";");

/** Parses the thermal script's line: the zones' passive limits and the processors' limit. */
export function parseWindowsThermal(out: string): { passive: number[]; perf?: number } | undefined {
  const m = /passive=([\d,]*) perf=(\d*)/.exec(out);
  if (m === null) return undefined;
  const passive = (m[1] ?? "")
    .split(",")
    .filter((s) => s !== "")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const perf = m[2] === "" || m[2] === undefined ? undefined : Number(m[2]);
  return { passive, ...(perf === undefined || !Number.isFinite(perf) ? {} : { perf }) };
}

/**
 * The limit as the nightly gates grade it, like macOS's CPU speed limit: the tightest thermal
 * zone, else (a PC without readable zones) the processors' performance limit. Unreadable is
 * nominal: most desktops report nothing, and the pass already waits for AC, idle and quiet hours.
 */
export function windowsThermalLevel(
  r: { passive: number[]; perf?: number } | undefined,
): ThermalLevel {
  const limit =
    r === undefined ? undefined : r.passive.length > 0 ? Math.min(...r.passive) : r.perf;
  if (limit === undefined) return "nominal";
  return limit >= 100 ? "nominal" : limit >= 80 ? "fair" : limit >= 50 ? "serious" : "critical";
}

export async function readWindowsThermal(run: Run = runFile): Promise<ThermalLevel> {
  const out = await run(
    POWERSHELL(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_THERMAL_SCRIPT,
    ],
    15_000,
  );
  return windowsThermalLevel(parseWindowsThermal(out));
}

/**
 * The account's full name for the owner's own card when USER.md has none: `id -F` on macOS, the
 * local account's Full Name on Windows (ADSI `WinNT://`; a Microsoft account sets it at sign-up).
 * Never throws; `undefined` when there is none.
 */
const fullNames = new Map<Platform, string | undefined>();

export function accountFullName(platform: Platform = process.platform): string | undefined {
  // Read once per process: the Windows read is a PowerShell run, and the name does not change
  // while psyched runs.
  if (fullNames.has(platform)) return fullNames.get(platform);
  const name = readAccountFullName(platform);
  fullNames.set(platform, name);
  return name;
}

function readAccountFullName(platform: Platform): string | undefined {
  try {
    if (platform === "darwin") {
      const out = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 2000 }).trim();
      return out === "" ? undefined : out;
    }
    if (platform === "win32") {
      const out = execFileSync(
        POWERSHELL(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "([adsi]('WinNT://' + $env:USERDOMAIN + '/' + $env:USERNAME + ',user')).FullName",
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return out === "" ? undefined : out;
    }
  } catch {
    // no name: the card falls back to the profile
  }
  return undefined;
}

/**
 * Where the Windows desktop app is installed per user: Squirrel.Windows (Electron Forge
 * `maker-squirrel`) puts its stub at `%LOCALAPPDATA%\<name>\<name>.exe`. `PSYCHE_DESKTOP_EXE`
 * overrides it (a portable or development build).
 */
export function windowsDesktopExe(
  env: NodeJS.ProcessEnv = process.env,
  appName = "Psyche",
): string {
  const explicit = env.PSYCHE_DESKTOP_EXE;
  if (explicit !== undefined && explicit !== "") return explicit;
  const local = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, appName, `${appName}.exe`);
}
