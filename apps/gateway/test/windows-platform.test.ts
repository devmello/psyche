import { isConferenceApp } from "@psyche/proactive";
import { describe, expect, it } from "vitest";
import { isSendApp } from "../src/compose/computer.ts";
import { hideAppleEntry } from "../src/compose/connectors.ts";
import { createDesktopLauncher, desktopInstalled } from "../src/compose/desktop-launch.ts";
import { readSystemState } from "../src/compose/everything-probe.ts";
import { powerReader, windowsPowerState } from "../src/compose/search-files.ts";
import { isHostHelperCapabilityReachable, isUnreachableCapability } from "../src/handlers/nodes.ts";
import {
  openExternalUrl,
  parseWindowsPower,
  parseWindowsThermal,
  readWindowsThermal,
  windowsDesktopExe,
  windowsThermalLevel,
} from "../src/platform.ts";

/** The Gateway's Windows branches, driven with fakes (no PowerShell, no browser, no app). */

describe("Windows power and idle state", () => {
  it("parses GetSystemPowerStatus and GetLastInputInfo", () => {
    expect(parseWindowsPower("ac=1 flag=128 pct=255 saver=0 idle=125000")).toEqual({
      onAc: true,
      noBattery: true,
      saver: false,
      idleMs: 125000,
    });
    expect(parseWindowsPower("ac=0 flag=8 pct=64 saver=1 idle=-1")).toEqual({
      onAc: false,
      noBattery: false,
      batteryPct: 64,
      saver: true,
    });
    expect(parseWindowsPower("ac=255 flag=0 pct=40 saver=0 idle=0")?.onAc).toBeUndefined();
    expect(parseWindowsPower("")).toBeUndefined();
  });

  it("a laptop on battery pauses indexing, a desktop PC never counts as on battery", async () => {
    expect(windowsPowerState({ onAc: false, noBattery: false, saver: false })).toEqual({
      onBattery: true,
      lowPower: false,
    });
    expect(windowsPowerState({ onAc: false, noBattery: true, saver: false }).onBattery).toBe(false);
    expect(windowsPowerState({ onAc: true, noBattery: false, saver: true }).lowPower).toBe(true);
    expect(windowsPowerState(undefined)).toEqual({ onBattery: false, lowPower: false });
    const read = powerReader("win32", 60_000, async () => ({
      onAc: false,
      noBattery: false,
      saver: true,
    }));
    await expect(read.fresh()).resolves.toEqual({ onBattery: true, lowPower: true });
    expect(read()).toEqual({ onBattery: true, lowPower: true });
  });

  it("the nightly gates read AC, battery saver and idle time; a failed read waits", async () => {
    const exec = async () => "";
    const s = await readSystemState(
      "win32",
      exec,
      () => 9,
      async () => ({
        onAc: false,
        noBattery: false,
        batteryPct: 80,
        saver: false,
        idleMs: 30 * 60_000,
      }),
      async () => "nominal",
    );
    expect(s).toEqual({
      onAc: false,
      batteryPct: 80,
      lowPowerMode: false,
      thermal: "nominal",
      idleMinutes: 30,
      freeMemBytes: 9,
    });
    const desktop = await readSystemState(
      "win32",
      exec,
      () => 9,
      async () => ({
        onAc: undefined,
        noBattery: true,
        saver: false,
      }),
      async () => "serious",
    );
    expect(desktop).toMatchObject({ onAc: true, idleMinutes: 999, thermal: "serious" });
    // A thermal read that fails is nominal, never a reason to wait forever.
    const noThermal = await readSystemState(
      "win32",
      exec,
      () => 9,
      async () => undefined,
      async () => {
        throw new Error("no powershell");
      },
    );
    expect(noThermal.thermal).toBe("nominal");
    const failed = await readSystemState(
      "win32",
      exec,
      () => 9,
      async () => undefined,
    );
    expect(failed.onAc).toBe(false);
  });
});

describe("Windows thermal state for the nightly memory pass", () => {
  it("grades the tightest thermal zone's passive limit like a Mac's CPU speed limit", () => {
    expect(parseWindowsThermal("passive=100,100 perf=100")).toEqual({
      passive: [100, 100],
      perf: 100,
    });
    expect(windowsThermalLevel(parseWindowsThermal("passive=100,100 perf=100"))).toBe("nominal");
    expect(windowsThermalLevel(parseWindowsThermal("passive=100,85 perf=100"))).toBe("fair");
    expect(windowsThermalLevel(parseWindowsThermal("passive=60 perf=100"))).toBe("serious");
    expect(windowsThermalLevel(parseWindowsThermal("passive=30 perf=100"))).toBe("critical");
  });

  it("falls back to the processors' performance limit without zones; unreadable is nominal", () => {
    expect(parseWindowsThermal("passive= perf=70")).toEqual({ passive: [], perf: 70 });
    expect(windowsThermalLevel(parseWindowsThermal("passive= perf=70"))).toBe("serious");
    expect(windowsThermalLevel(parseWindowsThermal("passive= perf="))).toBe("nominal");
    expect(windowsThermalLevel(parseWindowsThermal(""))).toBe("nominal");
    expect(windowsThermalLevel(undefined)).toBe("nominal");
  });

  it("reads it with one PowerShell run, no admin rights", async () => {
    const seen: string[][] = [];
    const level = await readWindowsThermal(async (file, args) => {
      seen.push([file, ...args]);
      return "passive=90 perf=100\r\n";
    });
    expect(level).toBe("fair");
    expect(seen[0]?.[0]).toMatch(/powershell\.exe$/i);
    expect(seen[0]?.join(" ")).toContain("ThermalZoneInformation");
    expect(seen[0]?.join(" ")).not.toContain("MSAcpi");
  });
});

describe("opening a consent page", () => {
  it("uses rundll32 url.dll on Windows and open on macOS, https only, no shell", () => {
    const runs: [string, string[]][] = [];
    const run = (file: string, args: string[]) => void runs.push([file, args]);
    const url = new URL("https://accounts.example.com/o/oauth2?state=a&b=c|d");
    expect(openExternalUrl(url, "win32", run)).toBe(true);
    expect(openExternalUrl(url, "darwin", run)).toBe(true);
    expect(openExternalUrl(url, "linux", run)).toBe(false);
    expect(openExternalUrl(new URL("file:///C:/x"), "win32", run)).toBe(false);
    expect(runs[0]?.[0]).toMatch(/[\\/]System32[\\/]rundll32\.exe$/i);
    expect(runs[0]?.[1]).toEqual(["url.dll,FileProtocolHandler", url.href]);
    expect(runs[1]).toEqual(["open", [url.href]]);
  });
});

describe("the desktop app on Windows", () => {
  // Windows-only: windowsDesktopExe joins with the host path module, which is win32 only on Windows.
  it.skipIf(process.platform !== "win32")(
    "is the per-user Squirrel install, started hidden and detached",
    async () => {
      const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
      expect(windowsDesktopExe(env)).toBe("C:\\Users\\me\\AppData\\Local\\Psyche\\Psyche.exe");
      expect(windowsDesktopExe({ ...env, PSYCHE_DESKTOP_EXE: "D:\\dev\\Psyche.exe" })).toBe(
        "D:\\dev\\Psyche.exe",
      );
      const runs: [string, string[]][] = [];
      const launch = createDesktopLauncher({
        platform: "win32",
        windowsExe: "C:\\Apps\\Psyche.exe",
        run: async (file, args) => void runs.push([file, args]),
      });
      await launch?.();
      expect(runs).toEqual([["C:\\Apps\\Psyche.exe", ["--background"]]]);
      expect(createDesktopLauncher({ platform: "linux" })).toBeUndefined();
      const seen: string[] = [];
      desktopInstalled((p) => {
        seen.push(p);
        return false;
      }, "win32");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/Psyche[\\/]Psyche\.exe$/);
    },
  );
});

describe("Apple connectors off macOS", () => {
  const entry = { id: "apple-notes" };
  const none = () => undefined;
  const helper = (capabilities: string[], platform?: "windows") => () => ({
    nodeId: "n",
    ...(platform === undefined ? {} : { platform }),
    capabilities,
    invoke: async () => ({ ok: false }),
  });
  it("leave the catalogue unless the Host helper offers their capabilities", () => {
    const winHelper = helper(["computer.click", "chrome.tabs"], "windows");
    const macHelper = helper(["notes.list"]);
    expect(hideAppleEntry(entry, none, "win32")).toBe(true);
    expect(hideAppleEntry(entry, winHelper, "win32")).toBe(true);
    expect(hideAppleEntry(entry, macHelper, "linux")).toBe(false);
    expect(hideAppleEntry(entry, none, "darwin")).toBe(false);
    expect(hideAppleEntry({ id: "google" }, none, "win32")).toBe(false);
    // Chrome tabs are served by the Windows helper itself; Things never is.
    expect(hideAppleEntry({ id: "chrome-tabs" }, winHelper, "win32")).toBe(false);
    expect(hideAppleEntry({ id: "things" }, winHelper, "win32")).toBe(true);
  });

  it("list Outlook's Mail, Calendar, Contacts and Reminders only with classic Outlook", () => {
    const outlook = helper(
      ["mail.mailboxes", "mail.selected", "calendar.list_calendars", "contacts.search"].concat(
        "reminders.list_lists",
      ),
      "windows",
    );
    const newOutlookOnly = helper(["computer.click", "files.recent"], "windows");
    for (const id of ["apple-mail", "apple-calendar", "apple-contacts", "apple-reminders"]) {
      expect(hideAppleEntry({ id }, outlook, "win32"), id).toBe(false);
      expect(hideAppleEntry({ id }, newOutlookOnly, "win32"), id).toBe(true);
    }
    // Mail is probed through mailboxes on Windows (selected answers [] without Outlook).
    expect(
      hideAppleEntry({ id: "apple-mail" }, helper(["mail.selected"], "windows"), "win32"),
    ).toBe(true);
    expect(hideAppleEntry({ id: "apple-files" }, newOutlookOnly, "win32")).toBe(false);
  });
});

describe("Windows app identities", () => {
  it("knows messaging apps by the lowercase executable the Windows helper names them by", () => {
    for (const id of [
      "slack.exe",
      "C:\\Users\\me\\AppData\\Local\\slack\\slack.exe",
      "ms-teams.exe",
      "olk.exe",
      "outlook.exe",
      "hxoutlook.exe",
      "whatsapp.root.exe",
      "telegram.exe",
      "signal.exe",
      "phoneexperiencehost.exe",
      "Discord.exe",
      "com.tinyspeck.slackmacgap",
    ]) {
      expect(isSendApp(id), id).toBe(true);
    }
    expect(isSendApp("notepad.exe")).toBe(false);
    expect(isSendApp("msedge.exe")).toBe(false);
    expect(isSendApp("C:\\slack.exe.bak\\notepad.exe")).toBe(false);
    // AppUserModelIDs are reported next to the id, never as it.
    expect(isSendApp("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App")).toBe(false);
  });

  it("knows conference apps the same way", () => {
    expect(isConferenceApp("us.zoom.xos")).toBe(true);
    expect(isConferenceApp("C:\\Users\\me\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe")).toBe(true);
    expect(isConferenceApp("MSTeams_8wekyb3d8bbwe!MSTeams")).toBe(true);
    expect(isConferenceApp("notepad.exe")).toBe(false);
  });
});

describe("what nodes.invoke can reach", () => {
  it("never teach.* or chrome.* on any node, and on a Host helper only the notification permission, the permission reads and Settings' listings", () => {
    for (const cap of [
      "teach.start",
      "teach.stop",
      "chrome.tabs",
      "chrome.current_tab",
      "presence.confirm",
    ]) {
      expect(isUnreachableCapability(cap), cap).toBe(true);
      expect(isHostHelperCapabilityReachable(cap), cap).toBe(false);
    }
    for (const cap of ["speech.transcribe_stream", "files.trash", "health", "computer.click"]) {
      expect(isHostHelperCapabilityReachable(cap), cap).toBe(false);
    }
    expect(isHostHelperCapabilityReachable("notify.authorization_status")).toBe(true);
    // psyche doctor reads what the OS granted the helper (read-only, never prompts).
    expect(isHostHelperCapabilityReachable("permissions.status")).toBe(true);
    expect(isHostHelperCapabilityReachable("permissions.request")).toBe(false);
    // Settings' trusted-sources and Shortcuts cards: the names of lists, never their items.
    for (const cap of ["reminders.list_lists", "calendar.list_calendars", "shortcuts.list"])
      expect(isHostHelperCapabilityReachable(cap), cap).toBe(true);
    for (const cap of ["reminders.list", "calendar.list_events", "shortcuts.run", "notes.read"])
      expect(isHostHelperCapabilityReachable(cap), cap).toBe(false);
    // Words that only start like a namespace are not that namespace.
    expect(isUnreachableCapability("teacher.list")).toBe(false);
  });
});
