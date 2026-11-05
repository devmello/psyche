import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import identity from "../../../win-helper/aumid.json" with { type: "json" };
import { LOGIN_ITEM_NAME, loginItemSettings } from "../../src/main/login-item.ts";
import {
  APP_AUMID,
  APP_ICON,
  gatewayTasks,
  HELPER_AUMID,
  HELPER_TOAST_CLSID,
  helperExe,
  installRoot,
  ownGatewayTasks,
  runSquirrelActions,
  type SquirrelAction,
  squirrelEvent,
  squirrelPlan,
  UNINSTALL_KEY,
  uninstallRegistryEntries,
} from "../../src/main/squirrel-events.ts";
import { APP_ICON as BUNDLED_APP_ICON } from "../../src/packaging/bundle-resources.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const TASK = `\\Psyche\\Gateway-${SID}`;
const paths = {
  exe: "C:\\Users\\me\\AppData\\Local\\Psyche\\app-0.3.0\\Psyche.exe",
  startMenu: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
  desktop: "C:\\Users\\me\\Desktop",
  psycheHome: "C:\\Users\\me\\.psyche",
  pid: 4321,
  gatewayTasks: [TASK, "\\Psyche\\Gateway"],
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
    const aumidKey = "HKCU\\Software\\Classes\\AppUserModelId\\com.psyche.helper";
    expect(reg).toContainEqual([
      "add",
      aumidKey,
      "/v",
      "DisplayName",
      "/t",
      "REG_SZ",
      "/d",
      "Psyche",
      "/f",
    ]);
    expect(reg).toContainEqual([
      "add",
      aumidKey,
      "/v",
      "CustomActivator",
      "/t",
      "REG_SZ",
      "/d",
      HELPER_TOAST_CLSID,
      "/f",
    ]);
  });

  it("registers what the helper registers itself (apps/win-helper/src/notify/toast.rs)", () => {
    const toast = readFileSync(
      join(import.meta.dirname, "../../../win-helper/src/notify/toast.rs"),
      "utf8",
    );
    expect(toast).toContain(`pub const AUMID: &str = "${HELPER_AUMID}";`);
    expect(toast).toContain(
      `pub const DISPLAY_NAME: &str = "${identity.helper.toastDisplayName}";`,
    );
    expect(toast).toContain(`pub const SHORTCUT_NAME: &str = "${identity.helper.shortcut}";`);
    expect(toast).toContain(`"${identity.helper.activatorName}"`);
    const hex = HELPER_TOAST_CLSID.slice(1, -1).replace(/-/g, "_");
    expect(toast).toContain(`GUID::from_u128(0x${hex})`);
  });

  it("updated: refreshes the shortcuts for the new version, the desktop one only if it is still there", () => {
    const links = shortcuts(squirrelPlan("updated", paths));
    expect(links.map((l) => l.operation)).toEqual(["create", "update", "create"]);
  });

  it("install and updated: Programs and Features' icon from the bundle, so Squirrel fetches none", () => {
    expect(APP_ICON).toBe(BUNDLED_APP_ICON);
    for (const event of ["install", "updated"] as const) {
      const plan = squirrelPlan(event, paths);
      // Squirrel downloads the nupkg's iconUrl into <root>\app.ico only while it is missing.
      expect(plan).toContainEqual({
        kind: "copy",
        from: `${ROOT}\\app-0.3.0\\resources\\icon.ico`,
        to: `${ROOT}\\app.ico`,
      });
      expect(plan).toContainEqual({
        kind: "run",
        cmd: "reg.exe",
        args: [
          "add",
          UNINSTALL_KEY,
          "/v",
          "DisplayIcon",
          "/t",
          "REG_SZ",
          "/d",
          `${ROOT}\\app.ico`,
          "/f",
        ],
      });
    }
    expect(UNINSTALL_KEY).toBe(
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Psyche",
    );
  });

  it("uninstall: ends the Gateway, deletes its tasks, the shortcuts, the activator, the login item and the URL handlers", () => {
    const plan = squirrelPlan("uninstall", paths);
    expect(plan[0]).toEqual({
      kind: "stopGateway",
      psycheHome: paths.psycheHome,
      tasks: paths.gatewayTasks,
    });
    for (const task of paths.gatewayTasks)
      expect(plan).toContainEqual({
        kind: "run",
        cmd: "schtasks.exe",
        args: ["/Delete", "/TN", task, "/F"],
        ignoreFailure: true,
      });
    expect(
      plan.filter((a) => a.kind === "remove").map((a) => a.kind === "remove" && a.file),
    ).toEqual([
      `${paths.startMenu}\\Psyche.lnk`,
      `${paths.desktop}\\Psyche.lnk`,
      `${paths.startMenu}\\Psyche Helper.lnk`,
    ]);
    const deleted = plan.flatMap((a) =>
      a.kind === "run" && a.cmd === "reg.exe" ? [a.args.slice(1, -1).join(" ")] : [],
    );
    expect(deleted).toEqual([
      `HKCU\\Software\\Classes\\CLSID\\${HELPER_TOAST_CLSID}`,
      "HKCU\\Software\\Classes\\AppUserModelId\\com.psyche.helper",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\com.psyche.helper",
      // app.setLoginItemSettings' value, and Task Manager's switch for it.
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ${LOGIN_ITEM_NAME}`,
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run /v ${LOGIN_ITEM_NAME}`,
      "HKCU\\Software\\Classes\\psyche",
      "HKCU\\Software\\Classes\\psyche-pair",
    ]);
    // The value the login item writes is the one removed.
    expect(loginItemSettings(true, "win32", paths.exe, { exists: () => true })?.name).toBe(
      LOGIN_ITEM_NAME,
    );
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

  it("uninstall ends this account's task and, only when it is this account's, the old shared one", () => {
    const ours =
      "<Task><Principals><Principal><UserId>DESK\\me</UserId></Principal></Principals></Task>";
    const theirs =
      "<Task><Principals><Principal><UserId>DESK\\you</UserId></Principal></Principals></Task>";
    const asked: string[] = [];
    const query = (xml: string | null) => (task: string) => {
      asked.push(task);
      return xml;
    };
    expect(gatewayTasks(SID, "DESK\\me", query(ours))).toEqual([TASK, "\\Psyche\\Gateway"]);
    expect(asked).toEqual(["\\Psyche\\Gateway"]);
    expect(gatewayTasks(SID, "DESK\\me", query(theirs))).toEqual([TASK]);
    expect(gatewayTasks(SID, "DESK\\me", query(null))).toEqual([TASK]);
    // Without a SID there is no name to delete (and the old one cannot be told apart).
    expect(gatewayTasks(null, "DESK\\me", query(ours))).toEqual([]);
  });

  it("uninstall leaves a task that runs another copy's runtime alone", () => {
    const task = (program: string) =>
      `<Task><Actions><Exec><Arguments>--headless "${program}" service-host.mjs --home C:\\h</Arguments></Exec></Actions></Task>`;
    const xml: Record<string, string | null> = {
      [TASK]: task(`${ROOT}\\app-0.3.0\\resources\\psyched\\runtime\\node.exe`),
      "\\Psyche\\Gateway": task("C:\\src\\psyche\\runtime\\node.exe"),
    };
    const query = (t: string) => xml[t] ?? null;
    expect(ownGatewayTasks([TASK, "\\Psyche\\Gateway"], ROOT, query)).toEqual([TASK]);
    // A task that is already gone stays in the list (deleting it is a no-op); one that names no
    // runtime is not provably ours.
    expect(ownGatewayTasks([TASK], ROOT, () => null)).toEqual([TASK]);
    expect(ownGatewayTasks([TASK], ROOT, () => "<Task/>")).toEqual([]);
  });

  it("the registry entries the in-app uninstall removes are the ones the hook removes", () => {
    const entries = uninstallRegistryEntries();
    const fromPlan = squirrelPlan("uninstall", paths).flatMap((a) =>
      a.kind === "run" && a.cmd === "reg.exe" ? [a.args.slice(1, -1)] : [],
    );
    expect(fromPlan).toEqual(entries.map((e) => [e.key, ...(e.value ? ["/v", e.value] : [])]));
    expect(entries.map((e) => e.key)).toContain("HKCU\\Software\\Classes\\psyche");
    expect(entries.every((e) => e.key.startsWith("HKCU\\"))).toBe(true);
  });

  it("carries out a copy action (the uninstall icon)", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-squirrel-"));
    dirs.push(dir);
    writeFileSync(join(dir, "icon.ico"), "ico");
    runSquirrelActions([{ kind: "copy", from: join(dir, "icon.ico"), to: join(dir, "app.ico") }], {
      writeShortcutLink: () => true,
      log: () => undefined,
    });
    expect(readFileSync(join(dir, "app.ico"), "utf8")).toBe("ico");
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
