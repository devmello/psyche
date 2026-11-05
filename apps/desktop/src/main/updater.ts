import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, autoUpdater } from "electron";
import {
  type ApplyResult,
  applyLinuxUpdate,
  nodeApplyFs,
  previousArtifact,
  type RollbackHooks,
  rollbackLinux,
  type StagedUpdate,
} from "../packaging/linux-apply.ts";
import type { UpdateGateway } from "../packaging/linux-gateway.ts";
import {
  detectInstallKind,
  evaluateLinuxGate,
  type InstallInfo,
  linuxUpdatePaths,
  type RunCommand,
} from "../packaging/linux-install.ts";
import { claimedRequirement } from "./bundle-integrity.ts";
import { TRUSTED_RELEASE_KEYS } from "./release-keys.ts";
import {
  checkForVerifiedUpdate,
  serveVerifiedUpdate,
  type UpdaterStateFile,
  writeUpdaterState,
} from "./update-flow.ts";
import {
  bundleOfExecutable,
  evaluateUpdaterGate,
  inspectQuarantine,
  readBundledPinned,
  satisfiesRequirement,
} from "./update-gate.ts";

/**
 * Auto-update (feature A6; security §11). Before Squirrel.Mac sees anything, the updater fetches
 * `update-manifest.json` from the pinned release host, verifies its Ed25519 signature with a key
 * embedded in the app (release-keys.ts), refuses downgrades and artifacts outside the pinned
 * host, downloads the zip and checks its SHA-256 and size (update-flow.ts). Only the verified file
 * is offered to Squirrel, through a loopback feed; Squirrel then checks the code signature too.
 *
 * Linux has no Squirrel: the same check runs, the verified AppImage, deb or rpm (the one matching
 * how this copy was installed) waits in ~/.cache/psyche/updates, and `applyPendingLinuxUpdate`
 * applies it when the owner chooses "Restart to update" (src/packaging/linux-apply.ts).
 *
 * Off unless the running app's own signature satisfies the designated requirement pinned in
 * deploy/macos/designated-requirements.txt (update-gate.ts: Psyche's self-signed release
 * certificate, or a Developer ID later), and while no release key is embedded. Ad-hoc and
 * development builds never update themselves.
 */

export type UpdaterState =
  | "disabled" // unpackaged, an unknown install kind (Linux), or not signed with the pinned release certificate
  | "no_keys" // no release key embedded yet: updates stay off
  | "none" // up to date (or no manifest published)
  | "refused" // a manifest or artifact failed verification; nothing applied
  | "started"; // a verified update is handed to Squirrel (macOS) or staged for the apply step (Linux)

export interface UpdaterOptions {
  /** Overrides the feed (PSYCHE_UPDATE_FEED); still must be on the pinned release host. */
  feedUrl?: string;
  /** Defaults to stderr. */
  log?: (message: string) => void;
  /** `$PSYCHE_HOME/run/updater.json`: the result, for `psyche security audit`. */
  stateFile?: string;
}

function stderrLog(message: string): void {
  process.stderr.write(`[updater] ${message}\n`);
}

let stopped = false;
const servers: { close(): unknown }[] = [];

/**
 * Uninstall: no more checks, the loopback feed closed and the listeners dropped, so Squirrel
 * (ShipIt) cannot be handed or reinstall an update after the app is in the Trash. The staged
 * download itself is the `psyche-update` temp dir and `~/Library/Caches/com.psyche.desktop.ShipIt`,
 * which the uninstall moves to the Trash.
 */
export function stopUpdater(): void {
  stopped = true;
  for (const s of servers.splice(0)) void s.close();
  linuxStaged = undefined;
  // Electron has no auto-updater on Linux; there is nothing to detach.
  if (process.platform !== "linux") autoUpdater.removeAllListeners();
}

// -- Linux ------------------------------------------------------------------------------------

/** What the desktop supplies for the Linux apply step; set once the Gateway supervisor exists. */
export interface LinuxUpdateHost extends RollbackHooks {
  /** `updateGateway(supervisor, () => gateway.call("gateway.prepareUpdate", …))`. */
  gateway: UpdateGateway;
}

let linuxHost: LinuxUpdateHost | undefined;
let linuxInstall: InstallInfo | undefined;
let linuxStaged: (StagedUpdate & { mandatory: boolean }) | undefined;

export function setLinuxUpdateHost(host: LinuxUpdateHost): void {
  linuxHost = host;
}

/** The verified update waiting for "Restart to update", if any. */
export function pendingLinuxUpdate(): { release: string; mandatory: boolean } | undefined {
  return linuxStaged && { release: linuxStaged.release, mandatory: linuxStaged.mandatory };
}

const nodeRun: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, stdout, stderr });
      reject(err);
    });
  });

function bundledBuild(): string | undefined {
  try {
    const info = JSON.parse(
      readFileSync(join(process.resourcesPath, "psyched", "build-info.json"), "utf8"),
    ) as { build?: unknown };
    return typeof info.build === "string" ? info.build : undefined;
  } catch {
    return undefined;
  }
}

function linuxApplyDeps(log: (m: string) => void) {
  if (!linuxHost) throw new Error("the Linux update host is not set");
  const install = linuxInstall;
  return {
    install,
    hooks: linuxHost,
    deps: {
      fs: nodeApplyFs,
      run: nodeRun,
      gateway: linuxHost.gateway,
      paths: linuxUpdatePaths(process.env),
      current: { version: app.getVersion(), build: bundledBuild() },
      log,
      relaunch: () => {
        const args = process.argv.slice(1);
        if (install?.appImagePath) app.relaunch({ execPath: install.appImagePath, args });
        else app.relaunch({ args });
        app.exit(0);
      },
    },
  };
}

/** "Restart to update": applies the staged, verified update. */
export async function applyPendingLinuxUpdate(log: (m: string) => void = stderrLog): Promise<ApplyResult> {
  const { install, deps } = linuxApplyDeps(log);
  if (!linuxStaged || !install) return { state: "failed", code: "missing_file", detail: "no update is staged" };
  const { mandatory: _mandatory, ...staged } = linuxStaged;
  const result = await applyLinuxUpdate(staged, install, deps);
  if (result.state === "applied") linuxStaged = undefined;
  return result;
}

/** The version "Go back to …" restores, when a previous artifact is kept. */
export async function linuxRollbackVersion(): Promise<string | undefined> {
  if (!linuxInstall) return undefined;
  const rec = await previousArtifact(nodeApplyFs, linuxUpdatePaths(process.env), linuxInstall.kind);
  return rec?.version;
}

export async function rollbackLinuxUpdate(log: (m: string) => void = stderrLog): Promise<ApplyResult> {
  const { install, deps, hooks } = linuxApplyDeps(log);
  if (!install) return { state: "failed", code: "no_previous", detail: "not an AppImage, deb or rpm install" };
  return rollbackLinux(install.kind, install.appImagePath, deps, hooks);
}

async function runLinuxUpdater(opts: UpdaterOptions, log: (m: string) => void): Promise<RunResult> {
  linuxInstall = await detectInstallKind({
    env: process.env,
    execPath: app.getPath("exe"),
    run: nodeRun,
  });
  const gate = evaluateLinuxGate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    keyCount: TRUSTED_RELEASE_KEYS.length,
    install: linuxInstall,
  });
  if (!gate.run) {
    if (gate.state === "no_keys") log(`${gate.why}: updates stay off`);
    return { state: gate.state };
  }
  const feed = opts.feedUrl ?? process.env.PSYCHE_UPDATE_FEED;
  const result = await checkForVerifiedUpdate({
    fetch,
    currentVersion: app.getVersion(),
    platform: "linux",
    arch: process.arch,
    installKind: gate.kind,
    keys: TRUSTED_RELEASE_KEYS,
    ...(feed ? { feed } : {}),
    dir: linuxUpdatePaths(process.env).updatesDir,
    log,
  }).catch((err: unknown) => {
    log(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { state: "none" as const, reason: "check failed" };
  });
  switch (result.state) {
    case "no_keys":
      return { state: "no_keys" };
    case "none":
      return { state: "none", reason: result.reason };
    case "refused":
      log(`refused update (${result.code}): ${result.reason}`);
      return { state: "refused", code: result.code, reason: result.reason };
    case "ready":
      if (stopped) return { state: "disabled" };
      linuxStaged = {
        release: result.release,
        file: result.file,
        artifact: result.artifact,
        mandatory: result.mandatory,
      };
      log(`Psyche ${result.release} is ready${result.mandatory ? " (required)" : ""}`);
      return { state: "started", release: result.release };
  }
}

export async function startUpdater(opts: UpdaterOptions = {}): Promise<UpdaterState> {
  const state = await runUpdater(opts);
  if (opts.stateFile) {
    try {
      writeUpdaterState(opts.stateFile, {
        state: state.state,
        appVersion: app.getVersion(),
        keys: TRUSTED_RELEASE_KEYS.length,
        checkedAt: new Date().toISOString(),
        ...(state.code ? { code: state.code } : {}),
        ...(state.reason ? { reason: state.reason } : {}),
        ...(state.release ? { release: state.release } : {}),
        ...(state.quarantine ? { quarantine: state.quarantine } : {}),
      });
    } catch {
      // The audit then reports the check as not run; the update itself is unaffected.
    }
  }
  return state.state;
}

type RunResult = { state: UpdaterState } & Partial<
  Pick<UpdaterStateFile, "code" | "reason" | "release" | "quarantine">
>;

async function runUpdater(opts: UpdaterOptions): Promise<RunResult> {
  const log = opts.log ?? stderrLog;
  if (stopped) return { state: "disabled" };
  if (process.platform === "linux") return runLinuxUpdater(opts, log);
  const gate = await evaluateUpdaterGate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    keyCount: TRUSTED_RELEASE_KEYS.length,
    bundlePath: bundleOfExecutable(app.getPath("exe")),
    readPinned: () => readBundledPinned(process.resourcesPath),
    // The claimed requirement plus a shallow `codesign --verify --strict`, not the integrity verdict:
    // a stray file in the bundle (a .DS_Store from Show Package Contents) must never block updates
    // forever. Squirrel still checks the new bundle against the requirement itself.
    satisfies: async (bundle, requirement) =>
      (await claimedRequirement(bundle)) === requirement &&
      (await satisfiesRequirement(bundle, requirement)),
  });
  if (!gate.run) {
    if (gate.state === "no_keys") log(`${gate.why}: updates stay off`);
    return { state: gate.state };
  }
  const feed = opts.feedUrl ?? process.env.PSYCHE_UPDATE_FEED;
  const result = await checkForVerifiedUpdate({
    fetch,
    currentVersion: app.getVersion(),
    arch: process.arch,
    keys: TRUSTED_RELEASE_KEYS,
    ...(feed ? { feed } : {}),
    dir: join(app.getPath("temp"), "psyche-update"),
    log,
    inspectDownload: (file) => inspectQuarantine(file),
  }).catch((err: unknown) => {
    log(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { state: "none" as const, reason: "check failed" };
  });

  switch (result.state) {
    case "no_keys":
      log("no release key embedded: updates stay off (security §11)");
      return { state: "no_keys" };
    case "none":
      return { state: "none", reason: result.reason };
    case "refused":
      log(`refused update (${result.code}): ${result.reason}`);
      return { state: "refused", code: result.code, reason: result.reason };
    case "ready": {
      if (stopped) return { state: "disabled" };
      const served = await serveVerifiedUpdate(result.file, result.release);
      servers.push(served);
      autoUpdater.on("error", (error) => {
        log(error.message);
        void served.close();
      });
      autoUpdater.on("update-downloaded", () => {
        log(
          `Psyche ${result.release} is ready; it installs when you quit${result.mandatory ? " (required)" : ""}`,
        );
        void served.close();
      });
      autoUpdater.setFeedURL({ url: served.feedUrl, serverType: "json" });
      autoUpdater.checkForUpdates();
      return {
        state: "started",
        release: result.release,
        ...(result.quarantine ? { quarantine: result.quarantine } : {}),
      };
    }
  }
}
