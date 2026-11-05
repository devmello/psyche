import { existsSync } from "node:fs";
import { join } from "node:path";
import { runElevated as defaultRunElevated, type ElevatedResult } from "./elevate.ts";
import {
  type DownloadProgress,
  downloadImage,
  folderSource,
  type GuestImageManifest,
  httpSource,
  ImageError,
  type ImageSource,
  imageSizes,
  installedImageVersion,
  parseManifest,
} from "./image.ts";
import { assessServiceUpdate, type ServiceUpdate, type ServiceVersion } from "./service-version.ts";

/**
 * "Turn on the sandbox PC" (Settings → Sandbox PC, onboarding's VM step on Windows): the three
 * things that need this app and not the Gateway, in order:
 *
 *  1. install the sandbox PC's Windows service, `psyche-vm-svc.exe install --owner-sid <SID>
 *     --home <PSYCHE_HOME>`, elevated: one UAC prompt, the only administrator step. The service
 *     runs as SYSTEM (it drives Hyper-V's Host Compute Service) but serves only this account;
 *  2. restart the helper, so its manifest now carries `vm.*` (it advertises them only once the
 *     service exists);
 *  3. download the guest image (a Linux kernel, initrd and root disk) per the published manifest:
 *     SHA-256 checked while it downloads and unpacks, kept in a folder only this account and
 *     SYSTEM can read.
 *
 * After an app update the installed service can be older than the one the build ships. Nothing
 * reinstalls it by itself (that needs an administrator): `check()` finds it out without any prompt,
 * and `updateService()` is the same elevated install as step 1, run only when the owner asks.
 *
 * Creating and starting the guest is then `vm.create` / `vm.start` on the helper, from the
 * Settings screen through the Gateway (it needs the Permission Broker, which this process does not
 * speak for).
 */

/** What the renderer is shown (the same shape as `SandboxPcState` in @psyche/ui). */
export interface SandboxPcState {
  phase:
    | "unsupported"
    | "off"
    | "installing"
    | "updating"
    | "downloading"
    | "restarting"
    | "ready"
    | "failed";
  /** Plain words: why it is unsupported or what failed. */
  message?: string;
  serviceInstalled: boolean;
  /** The guest image on disk, if a complete one is. */
  imageVersion: string | null;
  download?: { receivedBytes: number; totalBytes: number };
  /** The published image's download size, once the manifest was read. */
  downloadBytes?: number;
  /** Disk it takes unpacked. */
  diskBytes?: number;
  /**
   * Set while the installed service is older than the bundled one. `compatible`: it still speaks
   * the protocol this build's helper does, so the sandbox PC keeps working until it is updated.
   */
  serviceUpdate?: { installed: string; bundled: string; compatible: boolean };
}

type StatePatch = Omit<Partial<SandboxPcState>, "serviceUpdate"> & {
  phase: SandboxPcState["phase"];
  /** `null` clears it; left out keeps what is there. */
  serviceUpdate?: SandboxPcState["serviceUpdate"] | null;
};

/**
 * The guest image this build installs: a pinned release of deploy/windows/guest-image (the
 * `windows-guest-image` workflow publishes `vmlinuz`, `initrd`, `rootfs.vhdx.zst`, `manifest.json`
 * … as assets of release `windows-guest-image-v<version>`). Bump with each image the app should
 * use; the SHA-256s in that release's manifest are what the download is checked against.
 */
export const GUEST_IMAGE_VERSION = "0.1.0-84ef34a6";
export const DEFAULT_IMAGE_BASE_URL = `https://github.com/devmello/psyche/releases/download/windows-guest-image-v${GUEST_IMAGE_VERSION}/`;

export type ServiceProbe = "installed" | "notInstalled" | "unknown";

export interface SandboxPcDeps {
  platform: NodeJS.Platform;
  /** The account's SID (`currentUserSid()`); null when it cannot be read. */
  ownerSid: () => string | null;
  psycheHome: string;
  /** `%LOCALAPPDATA%\Psyche\vm-images`. */
  imagesRoot: string;
  /** The bundled `psyche-vm-svc.exe`, if this build has one. */
  serviceExe: string | undefined;
  /** Packaged builds must carry a valid Authenticode signature on the service. */
  requireSignature: boolean;
  /** `Get-AuthenticodeSignature` status of an exe (helper-launcher `authenticodeStatus`). */
  signatureOf?: (exe: string) => Promise<string | undefined>;
  /** `sc.exe query <service>`: installed, not installed, or unknown. */
  probeService: (serviceName: string) => Promise<ServiceProbe>;
  runElevated?: (exe: string, args: readonly string[]) => Promise<ElevatedResult>;
  /**
   * What tells an installed service from the bundled one; all three, or no update check.
   * `serviceVersionOf`: `psyche-vm-svc.exe version`. `installedServiceExe`: where `install` put it.
   */
  installedServiceExe?: (sid: string) => string;
  serviceVersionOf?: (exe: string) => Promise<ServiceVersion | null>;
  fileHash?: (exe: string) => Promise<string | null>;
  /** Limits a folder to this account and SYSTEM (icacls). */
  restrictFolder: (dir: string, sid: string) => Promise<void>;
  restartHelper: () => Promise<void>;
  /** Where the manifest and files come from: a release URL, or a local folder (development). */
  imageSource: { kind: "http"; baseUrl: string } | { kind: "folder"; dir: string };
  fetch?: typeof fetch;
  listDir: (dir: string) => string[];
  freeBytes?: (dir: string) => number;
  onState: (s: SandboxPcState) => void;
  log?: (m: string) => void;
}

export function serviceNameFor(sid: string): string {
  return `PsycheVM-${sid}`;
}

export class SandboxPc {
  readonly #d: SandboxPcDeps;
  #state: SandboxPcState;
  #manifest: { value: GuestImageManifest; text: string } | undefined;
  #abort: AbortController | undefined;
  #running: Promise<SandboxPcState> | undefined;

  constructor(deps: SandboxPcDeps) {
    this.#d = deps;
    this.#state = this.#unsupportedReason()
      ? {
          phase: "unsupported",
          message: this.#unsupportedReason(),
          serviceInstalled: false,
          imageVersion: null,
        }
      : { phase: "off", serviceInstalled: false, imageVersion: null };
  }

  #unsupportedReason(): string | undefined {
    if (this.#d.platform !== "win32") return "The sandbox PC runs on Windows";
    if (this.#d.serviceExe === undefined || !existsSync(this.#d.serviceExe))
      return "This build of Psyche has no sandbox PC service";
    if (this.#d.ownerSid() === null) return "Windows did not say which account this is";
    return undefined;
  }

  getState(): SandboxPcState {
    return this.#state;
  }

  #set(patch: StatePatch): SandboxPcState {
    const { download: _drop, message: _msg, serviceUpdate: before, ...keep } = this.#state;
    const { serviceUpdate: change, ...rest } = patch;
    const update = change === undefined ? before : (change ?? undefined);
    this.#state = { ...keep, ...rest, ...(update ? { serviceUpdate: update } : {}) };
    this.#d.onState(this.#state);
    return this.#state;
  }

  /** Whether the installed service is older than the bundled one (no prompt, no network). */
  async #assessUpdate(): Promise<ServiceUpdate | undefined> {
    const { installedServiceExe, serviceVersionOf, fileHash } = this.#d;
    const sid = this.#d.ownerSid();
    const bundledExe = this.#d.serviceExe;
    if (!installedServiceExe || !serviceVersionOf || !fileHash) return undefined;
    if (sid === null || bundledExe === undefined) return undefined;
    const installedExe = installedServiceExe(sid);
    const there = existsSync(installedExe);
    const [bundled, installed, bundledHash, installedHash] = await Promise.all([
      serviceVersionOf(bundledExe),
      there ? serviceVersionOf(installedExe) : Promise.resolve(null),
      fileHash(bundledExe),
      there ? fileHash(installedExe) : Promise.resolve(null),
    ]);
    // Not knowing what this build ships is no reason to nag.
    if (bundled === null) return undefined;
    return assessServiceUpdate({ bundled, installed, bundledHash, installedHash });
  }

  async #updateField(installed: boolean): Promise<Pick<StatePatch, "serviceUpdate">> {
    if (!installed) return { serviceUpdate: null };
    const u = await this.#assessUpdate().catch(() => undefined);
    if (u === undefined) return {};
    return {
      serviceUpdate:
        u.kind === "current"
          ? null
          : { installed: u.installed, bundled: u.bundled, compatible: u.compatible },
    };
  }

  #imageOnDisk(): string | null {
    return installedImageVersion(this.#d.imagesRoot, this.#d.listDir);
  }

  /**
   * Re-reads what is installed and, when the network answers, how big the image is. Never
   * throws: the answer is the state.
   */
  async refresh(): Promise<SandboxPcState> {
    return this.#refresh(true);
  }

  /**
   * What the app does when it starts (so also after an update): `refresh` without the network, so
   * a newer bundled service shows up as `serviceUpdate`. It never elevates.
   */
  async check(): Promise<SandboxPcState> {
    return this.#refresh(false);
  }

  async #refresh(network: boolean): Promise<SandboxPcState> {
    if (this.#running !== undefined || this.#state.phase === "unsupported") return this.#state;
    const sid = this.#d.ownerSid();
    if (sid === null) return this.#state;
    const probe = await this.#d.probeService(serviceNameFor(sid));
    const installed = probe === "installed";
    const image = this.#imageOnDisk();
    const sizes = network
      ? await this.#readManifest()
          .then((m) => imageSizes(m.value))
          .catch(() => undefined)
      : undefined;
    const update = probe === "unknown" ? {} : await this.#updateField(installed);
    // A turn-on or update that began meanwhile owns the state.
    if (this.#running !== undefined) return this.#state;
    return this.#set({
      phase: installed && image !== null ? "ready" : "off",
      serviceInstalled: installed,
      imageVersion: image,
      ...update,
      ...(sizes ? { downloadBytes: sizes.download, diskBytes: sizes.disk } : {}),
    });
  }

  #source(): ImageSource {
    const s = this.#d.imageSource;
    return s.kind === "folder" ? folderSource(s.dir) : httpSource(s.baseUrl, this.#d.fetch);
  }

  async #readManifest(): Promise<{ value: GuestImageManifest; text: string }> {
    if (this.#manifest !== undefined) return this.#manifest;
    let text: string;
    try {
      const src = this.#source();
      const chunks: Buffer[] = [];
      for await (const c of await src("manifest.json")) chunks.push(c as Buffer);
      text = Buffer.concat(chunks).toString("utf8");
    } catch (err) {
      if (err instanceof ImageError) throw err;
      throw new ImageError(
        "download_failed",
        `Could not read the guest image list (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (text.length > 64 * 1024)
      throw new ImageError("manifest_invalid", "The guest image list is too large");
    this.#manifest = { value: parseManifest(text), text };
    return this.#manifest;
  }

  /** Cancels a download in progress (the service stays installed). */
  cancel(): void {
    this.#abort?.abort();
  }

  /** Runs the whole flow; a second call while one runs joins it. */
  turnOn(): Promise<SandboxPcState> {
    this.#running ??= this.#turnOn().finally(() => {
      this.#running = undefined;
      this.#abort = undefined;
    });
    return this.#running;
  }

  /**
   * Replaces the installed service with the bundled one: the install command again, elevated (one
   * administrator prompt), and only because the owner asked. Installing stops the service, so a
   * running sandbox PC stops.
   */
  updateService(): Promise<SandboxPcState> {
    this.#running ??= this.#updateService().finally(() => {
      this.#running = undefined;
      this.#abort = undefined;
    });
    return this.#running;
  }

  async #updateService(): Promise<SandboxPcState> {
    const reason = this.#unsupportedReason();
    if (reason !== undefined) return this.#set({ phase: "unsupported", message: reason });
    const sid = this.#d.ownerSid() as string;
    const exe = this.#d.serviceExe as string;
    const log = this.#d.log ?? (() => undefined);
    const back = (): SandboxPcState["phase"] => (this.#imageOnDisk() !== null ? "ready" : "off");
    if ((await this.#d.probeService(serviceNameFor(sid))) !== "installed") {
      return this.#set({
        phase: "off",
        serviceInstalled: false,
        serviceUpdate: null,
        message: "The sandbox PC is not turned on, so there is no service to update",
      });
    }
    if (this.#d.requireSignature) {
      const status = await this.#d.signatureOf?.(exe);
      if (status !== "Valid") {
        return this.#set({
          phase: back(),
          message: "The new sandbox PC service is not signed by Psyche, so it was not installed",
        });
      }
    }
    this.#set({ phase: "updating", serviceInstalled: true });
    const run = this.#d.runElevated ?? defaultRunElevated;
    const res = await run(exe, ["install", "--owner-sid", sid, "--home", this.#d.psycheHome]);
    if (!res.ok) {
      log(`sandbox PC service update: ${res.message}`);
      return this.#set({
        phase: back(),
        message: res.cancelled
          ? "Updating the sandbox PC service needs one administrator approval. Nothing was changed."
          : res.message,
      });
    }
    const update = await this.#updateField(true);
    return this.#set({
      phase: back(),
      serviceInstalled: true,
      ...update,
      ...(update.serviceUpdate
        ? { message: "Windows did not finish updating the sandbox PC service" }
        : {}),
    });
  }

  async #turnOn(): Promise<SandboxPcState> {
    const reason = this.#unsupportedReason();
    if (reason !== undefined) return this.#set({ phase: "unsupported", message: reason });
    const sid = this.#d.ownerSid() as string;
    const exe = this.#d.serviceExe as string;
    const log = this.#d.log ?? (() => undefined);

    // 1. The service.
    let installed = (await this.#d.probeService(serviceNameFor(sid))) === "installed";
    if (!installed) {
      if (this.#d.requireSignature) {
        const status = await this.#d.signatureOf?.(exe);
        if (status !== "Valid") {
          return this.#set({
            phase: "failed",
            message: "The sandbox PC service is not signed by Psyche, so it was not installed",
          });
        }
      }
      this.#set({ phase: "installing", serviceInstalled: false });
      const run = this.#d.runElevated ?? defaultRunElevated;
      const res = await run(exe, ["install", "--owner-sid", sid, "--home", this.#d.psycheHome]);
      if (!res.ok) {
        log(`sandbox PC service install: ${res.message}`);
        return this.#set({
          phase: "failed",
          message: res.cancelled
            ? "Turning the sandbox PC on needs one administrator approval. Nothing was changed."
            : res.message,
        });
      }
      installed = (await this.#d.probeService(serviceNameFor(sid))) === "installed";
      if (!installed) {
        return this.#set({
          phase: "failed",
          message: "Windows did not register the sandbox PC service",
        });
      }
      // 2. A helper that started before the service knows nothing of vm.*.
      this.#set({ phase: "restarting", serviceInstalled: true });
      await this.#d.restartHelper().catch((err) => log(`helper restart: ${String(err)}`));
    }

    // 3. The guest image.
    let image = this.#imageOnDisk();
    if (image === null) {
      this.#abort = new AbortController();
      try {
        const manifest = await this.#readManifest();
        const sizes = imageSizes(manifest.value);
        this.#set({
          phase: "downloading",
          serviceInstalled: true,
          download: { receivedBytes: 0, totalBytes: sizes.download },
          downloadBytes: sizes.download,
          diskBytes: sizes.disk,
        });
        await this.#d.restrictFolder(this.#d.imagesRoot, sid);
        let last = 0;
        await downloadImage(manifest.value, manifest.text, {
          dir: join(this.#d.imagesRoot, manifest.value.imageVersion),
          signal: this.#abort.signal,
          source: this.#source(),
          ...(this.#d.freeBytes ? { freeBytes: this.#d.freeBytes } : {}),
          onProgress: (p: DownloadProgress) => {
            const now = Date.now();
            if (now - last < 250 && p.receivedBytes < p.totalBytes) return;
            last = now;
            this.#set({
              phase: "downloading",
              serviceInstalled: true,
              download: { receivedBytes: p.receivedBytes, totalBytes: p.totalBytes },
              downloadBytes: sizes.download,
              diskBytes: sizes.disk,
            });
          },
        });
        image = manifest.value.imageVersion;
      } catch (err) {
        if (err instanceof ImageError && err.reason === "cancelled") {
          return this.#set({ phase: "off", serviceInstalled: true });
        }
        const message = err instanceof Error ? err.message : String(err);
        log(`guest image: ${message}`);
        return this.#set({ phase: "failed", serviceInstalled: true, message });
      }
    }
    return this.#set({ phase: "ready", serviceInstalled: true, imageVersion: image });
  }
}
