import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { win32 } from "node:path";
import {
  currentUserSid,
  gatewayTaskName,
  LEGACY_GATEWAY_TASK,
  taskBelongsTo,
} from "@psyche/hostfs";
import identity from "../../../win-helper/aumid.json" with { type: "json" };
import { PAIR_LINK_SCHEME } from "../lib/pair-link.ts";
import { LOGIN_ITEM_NAME } from "./login-item.ts";
import { startElevatedDetached } from "./sandbox-pc/elevate.ts";
import { taskRunsFrom, windowsUserId } from "./supervisor-windows.ts";

/**
 * Squirrel.Windows install events (deploy/windows, docs/guides/install.md "Windows"). Squirrel
 * starts the new Psyche.exe with one of these as the first argument and waits up to 15 s for it to
 * exit; the app must do its install work and quit without opening a window:
 *
 *   --squirrel-install    first install: Start-menu and desktop shortcuts, the helper's shortcut and
 *                         its toast activator, the Programs and Features icon
 *   --squirrel-updated    after an update: the same, refreshed to the new version (the desktop
 *                         shortcut only when the owner kept it)
 *   --squirrel-uninstall  removes all of that, the Gateway task (\Psyche\Gateway-<SID>, and this
 *                         account's \Psyche\Gateway of an earlier version) when it runs from this
 *                         install folder (another copy's task is left alone; `ownGatewayTasks`),
 *                         whose node.exe would
 *                         otherwise keep files of the install folder open, the login item
 *                         (Settings › Appearance › Open at login) and the psyche:// and
 *                         psyche-pair: handlers the app registered
 *                         and the sandbox PC's Windows service (`psyche-vm-svc.exe uninstall`; it
 *                         needs an administrator, so when this process cannot do it an elevated
 *                         copy is started that outlives the hook, and the steps to do it by hand
 *                         are left in %TEMP%\Psyche-remove-sandbox-pc.txt)
 *   --squirrel-obsolete   an older version being replaced: nothing to do
 *   --squirrel-firstrun   the first normal launch after install: not handled here, the app starts
 *
 * Shortcuts are written by the app (shell.writeShortcutLink), not `Update.exe --createShortcut`,
 * because Squirrel stamps its own AppUserModelID (`com.squirrel.Psyche.Psyche`) on the shortcuts it
 * makes. The identity values (AUMIDs, the helper's toast activator CLSID) are shared with the Rust
 * helper through apps/win-helper/aumid.json.
 *
 * Programs and Features shows `<root>\app.ico`. Squirrel would download the nupkg's `iconUrl` into
 * that file after the install hook (Update.exe's CreateUninstallerRegistryEntry), but only when the
 * file does not exist yet: the hook copies the bundled `resources\icon.ico` there first and names
 * it as the uninstall entry's DisplayIcon, so an install never fetches anything.
 *
 * The helper stays at its versioned path inside app-<version> (no copy at a fixed path: a running
 * helper would lock the copy during an update). The helper re-registers its identity whenever it
 * starts, but creates its shortcut only when it is missing, so --squirrel-updated rewrites the
 * shortcut target and LocalServer32 for the new version; Squirrel keeps the previous app-<version>
 * until the next update, so a toast clicked in between still finds an executable.
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
/** `resources\icon.ico` (apps/desktop/src/packaging/bundle-resources.ts APP_ICON). */
export const APP_ICON = "icon.ico";
/** Squirrel's uninstall entry, named after the nupkg id (forge.config.ts MakerSquirrel `name`). */
export const UNINSTALL_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Psyche";
/** What `app.setLoginItemSettings` writes: a `Run` value, and its on/off switch in Task Manager. */
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const STARTUP_APPROVED_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
/** The URL schemes main.ts registers (`app.setAsDefaultProtocolClient`). */
export const URL_SCHEMES: readonly string[] = ["psyche", PAIR_LINK_SCHEME];

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
  /** This hook process, which must outlive the other Psyche.exe it ends on uninstall. */
  pid: number;
  /**
   * The Gateway tasks to end and delete on uninstall: this account's `\Psyche\Gateway-<SID>`, and
   * `\Psyche\Gateway` when an earlier version left one for this account (`gatewayTasks`).
   */
  gatewayTasks: readonly string[];
  /** The account's SID, for the sandbox PC's service (`PsycheVM-<SID>`); absent: none to remove. */
  ownerSid?: string | null;
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
  | { kind: "copy"; from: string; to: string }
  | { kind: "run"; cmd: string; args: string[]; ignoreFailure?: boolean }
  | { kind: "stopGateway"; psycheHome: string; tasks: readonly string[] }
  | { kind: "removeSandboxPc"; exe: string; sid: string };

export function installRoot(exe: string): string {
  // …\Psyche\app-<version>\Psyche.exe → …\Psyche
  return win32.dirname(win32.dirname(exe));
}

export function vmServiceExe(exe: string): string {
  return win32.join(
    win32.dirname(exe),
    "resources",
    identity.helper.resourcesDir,
    "psyche-vm-svc.exe",
  );
}

export function helperExe(exe: string): string {
  return win32.join(
    win32.dirname(exe),
    "resources",
    identity.helper.resourcesDir,
    identity.helper.exe,
  );
}

/** Set by the in-app uninstall (uninstall-windows.ts) when it already dealt with the sandbox PC. */
export const SANDBOX_PC_HANDLED_ENV = "PSYCHE_SANDBOX_PC_HANDLED";

const ACTIVATOR_KEY = `HKCU\\Software\\Classes\\CLSID\\${HELPER_TOAST_CLSID}`;
const AUMID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${HELPER_AUMID}`;
const NOTIFICATION_SETTINGS_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${HELPER_AUMID}`;

/**
 * What an uninstall removes from the registry, in order: the helper's toast identity and the
 * owner's notification choices for it, the login item and its Task Manager switch, and the URL
 * handlers. The in-app uninstall (uninstall-windows.ts) removes the same set before it hands over
 * to Squirrel, so both agree on what "Psyche's registry keys" are.
 */
export function uninstallRegistryEntries(): { key: string; value?: string }[] {
  return [
    { key: ACTIVATOR_KEY },
    { key: AUMID_KEY },
    // What the owner chose in Settings › Notifications for the helper.
    { key: NOTIFICATION_SETTINGS_KEY },
    // Open at login (login-item.ts): Electron's Run value, and the switch Windows keeps for it
    // once the owner turns it off in Task Manager or Settings › Apps › Startup.
    { key: RUN_KEY, value: LOGIN_ITEM_NAME },
    { key: STARTUP_APPROVED_KEY, value: LOGIN_ITEM_NAME },
    // The URL handlers main.ts registered; nothing would open them any more.
    ...URL_SCHEMES.map((scheme) => ({ key: `HKCU\\Software\\Classes\\${scheme}` })),
  ];
}

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
  // The helper's toast identity, per user, exactly as the helper registers it on every start
  // (apps/win-helper/src/notify/toast.rs), so the first toast works before the helper ever ran and
  // a click on one starts the helper of the installed version: the COM activator
  // (CLSID\{…}\LocalServer32) and the AUMID's DisplayName and CustomActivator.
  const regAdd = (key: string, name: string | null, data: string): SquirrelAction => ({
    kind: "run",
    cmd: "reg.exe",
    args: [
      "add",
      key,
      ...(name === null ? ["/ve"] : ["/v", name]),
      "/t",
      "REG_SZ",
      "/d",
      data,
      "/f",
    ],
  });
  const activator: SquirrelAction[] = [
    regAdd(ACTIVATOR_KEY, null, identity.helper.activatorName),
    regAdd(`${ACTIVATOR_KEY}\\LocalServer32`, null, `"${helper}" -ToastActivated`),
    regAdd(AUMID_KEY, "DisplayName", identity.helper.toastDisplayName),
    regAdd(AUMID_KEY, "CustomActivator", HELPER_TOAST_CLSID),
  ];
  const regDelete = (key: string, value?: string): SquirrelAction => ({
    kind: "run",
    cmd: "reg.exe",
    args: ["delete", key, ...(value === undefined ? [] : ["/v", value]), "/f"],
    ignoreFailure: true,
  });
  // Programs and Features' icon, local: Squirrel downloads iconUrl only while app.ico is missing.
  const appIcon = win32.join(root, "app.ico");
  const icon: SquirrelAction[] = [
    { kind: "copy", from: win32.join(win32.dirname(p.exe), "resources", APP_ICON), to: appIcon },
    regAdd(UNINSTALL_KEY, "DisplayIcon", appIcon),
  ];
  switch (event) {
    case "install":
      return [
        appLink(p.startMenu, "create"),
        appLink(p.desktop, "create"),
        helperLink,
        ...activator,
        ...icon,
      ];
    case "updated":
      return [
        appLink(p.startMenu, "create"),
        appLink(p.desktop, "update"),
        helperLink,
        ...activator,
        ...icon,
      ];
    case "uninstall":
      return [
        { kind: "stopGateway", psycheHome: p.psycheHome, tasks: p.gatewayTasks },
        // The sandbox PC's service runs from its own protected copy and nothing in app-<version>
        // keeps it alive, but it is registered with Windows: take it out.
        ...(p.ownerSid
          ? [{ kind: "removeSandboxPc", exe: vmServiceExe(p.exe), sid: p.ownerSid } as const]
          : []),
        // A running Psyche or helper keeps app-<version> open, and Squirrel then leaves the folder
        // behind (marked .dead). End them; this hook process stays.
        {
          kind: "run",
          cmd: "taskkill.exe",
          args: ["/F", "/T", "/FI", `IMAGENAME eq ${identity.helper.exe}`],
          ignoreFailure: true,
        },
        {
          kind: "run",
          cmd: "taskkill.exe",
          args: ["/F", "/FI", `IMAGENAME eq ${identity.app.exe}`, "/FI", `PID ne ${p.pid}`],
          ignoreFailure: true,
        },
        ...p.gatewayTasks.map(
          (task): SquirrelAction => ({
            kind: "run",
            cmd: "schtasks.exe",
            args: ["/Delete", "/TN", task, "/F"],
            ignoreFailure: true,
          }),
        ),
        { kind: "remove", file: win32.join(p.startMenu, identity.app.shortcut) },
        { kind: "remove", file: win32.join(p.desktop, identity.app.shortcut) },
        { kind: "remove", file: win32.join(p.startMenu, identity.helper.shortcut) },
        ...uninstallRegistryEntries().map((e) => regDelete(e.key, e.value)),
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
 * This account's Gateway tasks: `\Psyche\Gateway-<SID>`, and the shared `\Psyche\Gateway` of an
 * earlier version when it runs as this account (another account's is not ours to delete).
 */
export function gatewayTasks(
  sid: string | null,
  userId: string | undefined,
  queryXml: (task: string) => string | null,
): string[] {
  if (sid === null) return [];
  const legacy = queryXml(LEGACY_GATEWAY_TASK);
  const ours = legacy !== null && taskBelongsTo(legacy, { sid, ...(userId ? { userId } : {}) });
  return [gatewayTaskName(sid), ...(ours ? [LEGACY_GATEWAY_TASK] : [])];
}

/**
 * Of this account's Gateway tasks, the ones that run from this install folder. A task that runs
 * another copy's runtime (a checkout, another install) is not ours to end or delete, so it stays;
 * a task that no longer exists is kept in the list (deleting it is a no-op).
 */
export function ownGatewayTasks(
  tasks: readonly string[],
  root: string,
  queryXml: (task: string) => string | null,
): string[] {
  return tasks.filter((task) => {
    const xml = queryXml(task);
    return xml === null || taskRunsFrom(xml, root);
  });
}

function queryTaskXml(task: string): string | null {
  const r = spawnSync("schtasks.exe", ["/Query", "/TN", task, "/XML"], {
    windowsHide: true,
    timeout: 5000,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout : null;
}

/**
 * The Gateway task runs a service host and node.exe from this install folder
 * (apps/cli/src/supervisor.ts); `schtasks /End` ends only conhost, so their pids end the tree.
 */
function stopGateway(psycheHome: string, tasks: readonly string[]): void {
  for (const task of tasks) run("schtasks.exe", ["/End", "/TN", task]);
  for (const f of ["gateway-service.pid", "gateway.pid"]) {
    const pid = readPid(win32.join(psycheHome, "run", f));
    if (pid) run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  }
}

/** What to do by hand when the service could not be removed here. */
export function removalNote(sid: string): string {
  const name = `PsycheVM-${sid}`;
  return [
    "Psyche was uninstalled, but its sandbox PC service may still be registered with Windows.",
    "If the administrator prompt appeared and you approved it, nothing else is needed.",
    "Otherwise open Windows Terminal as an administrator and run:",
    "",
    `  sc.exe stop ${name}`,
    `  sc.exe delete ${name}`,
    "",
    "Then delete the folder %LOCALAPPDATA%\\Psyche\\vm-images if you do not want the guest image.",
    "",
  ].join("\r\n");
}

/**
 * Removes the sandbox PC's service. A copy of the exe in %TEMP% does the work, so the install
 * folder is free for Squirrel to delete. First without elevation (an administrator account that
 * already runs elevated, or a service this account may delete); when that fails, an elevated copy
 * is started and not waited for (Squirrel gives this hook 15 s, a UAC prompt can take longer).
 */
function removeSandboxPc(exe: string, sid: string, rt: SquirrelRuntime): void {
  const probe = spawnSync("sc.exe", ["query", `PsycheVM-${sid}`], {
    windowsHide: true,
    timeout: 5000,
    stdio: "ignore",
  });
  // 1060: not installed. Anything else (0, or access denied) means there is something to remove.
  if (probe.status === 1060) return;
  if (!existsSync(exe)) {
    rt.log("the sandbox PC service is installed but its program is missing");
  }
  const dir = mkdtempSync(win32.join(tmpdir(), "psyche-vm-uninstall-"));
  const copy = win32.join(dir, "psyche-vm-svc.exe");
  let ran = false;
  if (existsSync(exe)) {
    copyFileSync(exe, copy);
    const r = spawnSync(copy, ["uninstall"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
    if (r.status === 0) return;
    ran = startElevatedDetached(copy, ["uninstall"]);
  }
  const note = win32.join(tmpdir(), "Psyche-remove-sandbox-pc.txt");
  writeFileSync(note, removalNote(sid));
  rt.log(
    ran
      ? `the sandbox PC service is being removed (administrator prompt); steps if it fails: ${note}`
      : `the sandbox PC service could not be removed here; steps: ${note}`,
  );
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
      } else if (a.kind === "copy") {
        copyFileSync(a.from, a.to);
      } else if (a.kind === "stopGateway") {
        stopGateway(a.psycheHome, a.tasks);
      } else if (a.kind === "removeSandboxPc") {
        removeSandboxPc(a.exe, a.sid, rt);
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
    pid: process.pid,
    gatewayTasks:
      event === "uninstall"
        ? ownGatewayTasks(
            gatewayTasks(currentUserSid(), windowsUserId(env), queryTaskXml),
            installRoot(process.execPath),
            queryTaskXml,
          )
        : [],
    // The in-app uninstall already dealt with the service (one prompt, or the manual steps).
    ownerSid:
      event === "uninstall" && env[SANDBOX_PC_HANDLED_ENV] !== "1" ? currentUserSid() : null,
  };
  runSquirrelActions(squirrelPlan(event, paths), {
    writeShortcutLink: (f, op, o) => electron.shell.writeShortcutLink(f, op, o),
    log: (m) => process.stderr.write(`[squirrel] ${m}\n`),
  });
  return true;
}
