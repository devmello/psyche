import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import identity from "../../../win-helper/aumid.json" with { type: "json" };
import {
  APP_AUMID,
  GATEWAY_TASK,
  HELPER_AUMID,
  HELPER_TOAST_CLSID,
  helperExe,
  installRoot,
  runSquirrelActions,
  type SquirrelAction,
  squirrelEvent,
  squirrelPlan,
} from "../../src/main/squirrel-events.ts";

const paths = {
  exe: "C:\\Users\\me\\AppData\\Local\\Psyche\\app-0.3.0\\Psyche.exe",
  startMenu: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
  desktop: "C:\\Users\\me\\Desktop",
  psycheHome: "C:\\Users\\me\\.psyche",
  pid: 4321,
};
const ROOT = "C:\\Users\\me\\AppData\\Local\\Psyche";
const STUB = `${ROOT}\\Psyche.exe`;
const HELPER = `${ROOT}\\app-0.3.0\\resources\\win-helper\\psyche-helper.exe`;

const shortcuts = (a: SquirrelAction[]) =>
  a.flatMap((x) => (x.kind === "shortcut" ? [x.spec] : []));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Squirrel events", () => {
  it("reads the event from argv[1] only", () => {
    expect(squirrelEvent(["Psyche.exe", "--squirrel-install", "0.3.0"])).toBe("install");
    expect(squirrelEvent(["Psyche.exe", "--squirrel-updated", "0.3.1"])).toBe("updated");
    expect(squirrelEvent(["Psyche.exe", "--squirrel-uninstall"])).toBe("uninstall");
    expect(squirrelEvent(["Psyche.exe", "--squirrel-obsolete"])).toBe("obsolete");
    // The first normal launch starts the app.
    expect(squirrelEvent(["Psyche.exe", "--squirrel-firstrun"])).toBeNull();
    expect(squirrelEvent(["Psyche.exe", "psyche://x", "--squirrel-install"])).toBeNull();
    expect(squirrelEvent(["Psyche.exe"])).toBeNull();
  });

  it("shares its identity with the helper through apps/win-helper/aumid.json", () => {
    expect(APP_AUMID).toBe("com.psyche.desktop");
    expect(HELPER_AUMID).toBe("com.psyche.helper");
    expect(HELPER_TOAST_CLSID).toBe(identity.helper.toastActivatorClsid);
    expect(HELPER_TOAST_CLSID).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/);
  });

  it("finds the install root and the helper from app-<version>\\Psyche.exe", () => {
    expect(installRoot(paths.exe)).toBe(ROOT);
    expect(helperExe(paths.exe)).toBe(HELPER);
  });

  it("install: Start-menu and desktop shortcuts on the stub with the app's AUMID, the helper's with its activator", () => {
    const plan = squirrelPlan("install", paths);
    const links = shortcuts(plan);
    expect(links.map((l) => [l.file, l.operation])).toEqual([
      [`${paths.startMenu}\\Psyche.lnk`, "create"],
      [`${paths.desktop}\\Psyche.lnk`, "create"],
      [`${paths.startMenu}\\Psyche Helper.lnk`, "create"],
    ]);
    for (const l of links.slice(0, 2)) {
      expect(l).toMatchObject({ target: STUB, appUserModelId: APP_AUMID, cwd: ROOT });
      expect(l.toastActivatorClsid).toBeUndefined();
    }
    expect(links[2]).toMatchObject({
      target: HELPER,
      appUserModelId: HELPER_AUMID,
      toastActivatorClsid: HELPER_TOAST_CLSID,
    });
    const reg = plan.flatMap((a) => (a.kind === "run" ? [a.args] : []));
    expect(reg).toContainEqual([
      "add",
      `HKCU\\Software\\Classes\\CLSID\\${HELPER_TOAST_CLSID}\\LocalServer32`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      `"${HELPER}" -ToastActivated`,
      "/f",
    ]);
  });

  it("updated: refreshes the shortcuts for the new version, the desktop one only if it is still there", () => {
    const links = shortcuts(squirrelPlan("updated", paths));
    expect(links.map((l) => l.operation)).toEqual(["create", "update", "create"]);
  });

  it("uninstall: ends the Gateway, deletes its task, the shortcuts and the activator", () => {
    const plan = squirrelPlan("uninstall", paths);
    expect(plan[0]).toEqual({ kind: "stopGateway", psycheHome: paths.psycheHome });
    expect(plan).toContainEqual({
      kind: "run",
      cmd: "schtasks.exe",
      args: ["/Delete", "/TN", GATEWAY_TASK, "/F"],
      ignoreFailure: true,
    });
    expect(
      plan.filter((a) => a.kind === "remove").map((a) => a.kind === "remove" && a.file),
    ).toEqual([
      `${paths.startMenu}\\Psyche.lnk`,
      `${paths.desktop}\\Psyche.lnk`,
      `${paths.startMenu}\\Psyche Helper.lnk`,
    ]);
    expect(GATEWAY_TASK).toBe("\\Psyche\\Gateway");
    // Every other Psyche.exe and the helper end, so Squirrel can delete app-<version>.
    expect(plan).toContainEqual({
      kind: "run",
      cmd: "taskkill.exe",
      args: ["/F", "/FI", "IMAGENAME eq Psyche.exe", "/FI", "PID ne 4321"],
      ignoreFailure: true,
    });
    expect(squirrelPlan("obsolete", paths)).toEqual([]);
  });

  it("carries out a plan: skips an update of a missing shortcut, removes files, keeps going after a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-squirrel-"));
    dirs.push(dir);
    const gone = join(dir, "gone.lnk");
    writeFileSync(gone, "lnk");
    const written: string[] = [];
    const logs: string[] = [];
    const spec = (file: string, operation: "create" | "update") => ({
      kind: "shortcut" as const,
      spec: {
        file,
        operation,
        target: "t.exe",
        appUserModelId: "a",
        description: "d",
        icon: "t.exe",
        cwd: dir,
      },
    });
    runSquirrelActions(
      [
        spec(join(dir, "missing.lnk"), "update"),
        spec(join(dir, "bad.lnk"), "create"),
        spec(join(dir, "new.lnk"), "create"),
        { kind: "remove", file: gone },
      ],
      {
        writeShortcutLink: (file, op, opts) => {
          if (file.endsWith("bad.lnk")) throw new Error("boom");
          written.push(`${win32.basename(file)} ${op} ${opts.appUserModelId} ${opts.iconIndex}`);
          return true;
        },
        log: (m) => logs.push(m),
      },
    );
    expect(written).toEqual(["new.lnk create a 0"]);
    expect(logs).toEqual(["boom"]);
    expect(existsSync(gone)).toBe(false);
  });

  it("the aumid.json the helper reads names the files the installer writes", () => {
    const json = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../win-helper/aumid.json"), "utf8"),
    ) as typeof identity;
    expect(json.helper).toMatchObject({
      exe: "psyche-helper.exe",
      resourcesDir: "win-helper",
      shortcut: "Psyche Helper.lnk",
    });
  });
});
