import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import identity from "../../../win-helper/aumid.json" with { type: "json" };

/**
 * Squirrel.Windows install events (deploy/windows, docs/guides/install.md "Windows"). Squirrel
 * starts the new Psyche.exe with one of these as the first argument and waits up to 15 s for it to
 * exit; the app must do its install work and quit without opening a window:
 *
 *   --squirrel-install    first install: Start-menu and desktop shortcuts, the helper's shortcut and
 *                         its toast activator
 *   --squirrel-updated    after an update: the same, refreshed to the new version (the desktop
 *                         shortcut only when the owner kept it)
 *   --squirrel-uninstall  removes all of that, and the Gateway task (\Psyche\Gateway), whose
 *                         node.exe would otherwise keep files of the install folder open
 *   --squirrel-obsolete   an older version being replaced: nothing to do
 *   --squirrel-firstrun   the first normal launch after install: not handled here, the app starts
 *
 * Shortcuts are written by the app (shell.writeShortcutLink), not `Update.exe --createShortcut`,
 * because Squirrel stamps its own AppUserModelID (`com.squirrel.Psyche.Psyche`) on the shortcuts it
 * makes. The identity values (AUMIDs, the helper's toast activator CLSID) are shared with the Rust
 * helper through apps/win-helper/aumid.json.
 *
 * Install layout (Squirrel, per user, no admin):
 *   %LOCALAPPDATA%\Psyche\Update.exe                     Squirrel
 *   %LOCALAPPDATA%\Psyche\Psyche.exe                     the stub that starts the newest version
 *   %LOCALAPPDATA%\Psyche\app-<version>\Psyche.exe       this executable
 *   %LOCALAPPDATA%\Psyche\app-<version>\resources\win-helper\psyche-helper.exe
 */

export const APP_AUMID: string = identity.app.aumid;
export const HELPER_AUMID: string = identity.helper.aumid;
export const HELPER_TOAST_CLSID: string = identity.helper.toastActivatorClsid;
export const GATEWAY_TASK = "\\Psyche\\Gateway";

export type SquirrelEvent = "install" | "updated" | "uninstall" | "obsolete";

export function squirrelEvent(argv: readonly string[]): SquirrelEvent | null {
  const m = /^--squirrel-(install|updated|uninstall|obsolete)$/.exec(argv[1] ?? "");
  return m ? (m[1] as SquirrelEvent) : null;
}

/** Where things are, for one event. `exe` is this Psyche.exe (inside app-<version>). */
export interface SquirrelPaths {
  exe: string;
  /** `%APPDATA%\Microsoft\Windows\Start Menu\Programs` */
  startMenu: string;
  desktop: string;
  psycheHome: string;
}

export interface ShortcutSpec {
  file: string;
  target: string;
  /** "create" overwrites; "update" changes only an existing shortcut. */
  operation: "create" | "update";
  appUserModelId: string;
  toastActivatorClsid?: string;
  description: string;
  icon: string;
  cwd: string;
}

export type SquirrelAction =
  | { kind: "shortcut"; spec: ShortcutSpec }
  | { kind: "remove"; file: string }
  | { kind: "run"; cmd: string; args: string[]; ignoreFailure?: boolean }
  | { kind: "stopGateway"; psycheHome: string };

export function installRoot(exe: string): string {
  // …\Psyche\app-<version>\Psyche.exe → …\Psyche
  return win32.dirname(win32.dirname(exe));
}

export function helperExe(exe: string): string {
  return win32.join(
    win32.dirname(exe),
    "resources",
    identity.helper.resourcesDir,
    identity.helper.exe,
  );
}

const ACTIVATOR_KEY = `HKCU\\Software\\Classes\\CLSID\\${HELPER_TOAST_CLSID}`;

/** What an event does, as data (tests check it; runSquirrelActions carries it out). */
export function squirrelPlan(event: SquirrelEvent, p: SquirrelPaths): SquirrelAction[] {
  const root = installRoot(p.exe);
  // The root stub always starts the newest app-<version>, so these survive updates.
  const stub = win32.join(root, identity.app.exe);
  const helper = helperExe(p.exe);
  const appLink = (dir: string, operation: ShortcutSpec["operation"]): SquirrelAction => ({
    kind: "shortcut",
    spec: {
      file: win32.join(dir, identity.app.shortcut),
      target: stub,
      operation,
      appUserModelId: APP_AUMID,
      description: "Psyche, your personal AI agent",
      icon: stub,
      cwd: root,
    },
  });
  // The helper's Start-menu shortcut names its AUMID and toast activator: Windows needs both to
  // show its toasts and to start it when one is clicked while it is not running. The target is
  // versioned, so every update rewrites it.
  const helperLink: SquirrelAction = {
    kind: "shortcut",
    spec: {
      file: win32.join(p.startMenu, identity.helper.shortcut),
      target: helper,
      operation: "create",
      appUserModelId: HELPER_AUMID,
      toastActivatorClsid: HELPER_TOAST_CLSID,
      description: `${identity.helper.displayName} (notifications and system access for Psyche)`,
      icon: stub,
      cwd: win32.dirname(helper),
    },
  };
  // COM registration of the toast activator (per user): a click on a toast starts the helper.
  const activator: SquirrelAction[] = [
    {
      kind: "run",
      cmd: "reg.exe",
      args: [
        "add",
        `${ACTIVATOR_KEY}\\LocalServer32`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        `"${helper}" -ToastActivated`,
        "/f",
      ],
    },
    {
      kind: "run",
      cmd: "reg.exe",
      args: ["add", ACTIVATOR_KEY, "/ve", "/t", "REG_SZ", "/d", identity.helper.displayName, "/f"],
    },
  ];
  switch (event) {
    case "install":
      return [
        appLink(p.startMenu, "create"),
        appLink(p.desktop, "create"),
        helperLink,
        ...activator,
      ];
    case "updated":
      return [
        appLink(p.startMenu, "create"),
        appLink(p.desktop, "update"),
        helperLink,
        ...activator,
      ];
    case "uninstall":
      return [
        { kind: "stopGateway", psycheHome: p.psycheHome },
        {
          kind: "run",
          cmd: "schtasks.exe",
          args: ["/Delete", "/TN", GATEWAY_TASK, "/F"],
          ignoreFailure: true,
        },
        { kind: "remove", file: win32.join(p.startMenu, identity.app.shortcut) },
        { kind: "remove", file: win32.join(p.desktop, identity.app.shortcut) },
        { kind: "remove", file: win32.join(p.startMenu, identity.helper.shortcut) },
        {
          kind: "run",
          cmd: "reg.exe",
          args: ["delete", ACTIVATOR_KEY, "/f"],
          ignoreFailure: true,
        },
      ];
    case "obsolete":
      return [];
  }
}

export interface SquirrelRuntime {
  /** Electron's shell.writeShortcutLink. */
  writeShortcutLink(
    file: string,
    operation: "create" | "update",
    options: {
      target: string;
      cwd: string;
      description: string;
      icon: string;
      iconIndex: number;
      appUserModelId: string;
      toastActivatorClsid?: string;
    },
  ): boolean;
  log(message: string): void;
}

function readPid(file: string): number | null {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { windowsHide: true, timeout: 5000, stdio: "ignore" });
  return r.status ?? 1;
}

/**
 * The Gateway task runs a service host and node.exe from this install folder
 * (apps/cli/src/supervisor.ts); `schtasks /End` ends only conhost, so their pids end the tree.
 */
function stopGateway(psycheHome: string): void {
  run("schtasks.exe", ["/End", "/TN", GATEWAY_TASK]);
  for (const f of ["gateway-service.pid", "gateway.pid"]) {
    const pid = readPid(win32.join(psycheHome, "run", f));
    if (pid) run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  }
}

export function runSquirrelActions(actions: readonly SquirrelAction[], rt: SquirrelRuntime): void {
  for (const a of actions) {
    try {
      if (a.kind === "shortcut") {
        const { file, operation, ...opts } = a.spec;
        if (operation === "update" && !existsSync(file)) continue;
        if (!rt.writeShortcutLink(file, operation, { ...opts, iconIndex: 0 }))
          rt.log(`could not write ${file}`);
      } else if (a.kind === "remove") {
        rmSync(a.file, { force: true });
      } else if (a.kind === "stopGateway") {
        stopGateway(a.psycheHome);
      } else {
        const code = run(a.cmd, a.args);
        if (code !== 0 && !a.ignoreFailure) rt.log(`${a.cmd} ${a.args[0]} exited ${code}`);
      }
    } catch (err) {
      // An install step that fails must not keep Squirrel waiting or abort the rest.
      rt.log(err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Call first thing in main.ts. On Windows, for a Squirrel event: does the work (all of it
 * synchronous) and returns true; main.ts then exits at once, before any window, lock or Gateway.
 * Otherwise returns false.
 */
export function handleSquirrelEvent(
  electron: {
    app: { getPath(name: "appData" | "desktop"): string };
    shell: Pick<SquirrelRuntime, "writeShortcutLink">;
  },
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (process.platform !== "win32") return false;
  const event = squirrelEvent(argv);
  if (!event) return false;
  const paths: SquirrelPaths = {
    exe: process.execPath,
    startMenu: win32.join(
      electron.app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
    ),
    desktop: electron.app.getPath("desktop"),
    psycheHome: env.PSYCHE_HOME ?? win32.join(homedir(), ".psyche"),
  };
  runSquirrelActions(squirrelPlan(event, paths), {
    writeShortcutLink: (f, op, o) => electron.shell.writeShortcutLink(f, op, o),
    log: (m) => process.stderr.write(`[squirrel] ${m}\n`),
  });
  return true;
}
