import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { currentUserSid } from "@psyche/hostfs";
import { authenticodeStatus } from "../helper-launcher.ts";
import type { Runner } from "../supervisor-base.ts";
import {
  DEFAULT_MANIFEST_URL,
  SandboxPc,
  type SandboxPcState,
  serviceNameFor,
} from "./sandbox-pc.ts";

export const SERVICE_DIR = "win-helper";
export const SERVICE_EXE = "psyche-vm-svc.exe";

/**
 * Where `psyche-vm-svc.exe` is: next to `psyche-helper.exe` in the packaged resources; unpackaged,
 * the Rust build in the repo (`apps/win-helper/target/{release,debug}`).
 */
export function serviceExeFor(o: {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` when unpackaged. */
  appPath: string;
  exists: (path: string) => boolean;
}): string | undefined {
  if (o.platform !== "win32") return undefined;
  if (o.packaged) return join(o.resourcesPath, SERVICE_DIR, SERVICE_EXE);
  const target = join(o.appPath, "..", "win-helper", "target");
  return ["release", "debug"].map((p) => join(target, p, SERVICE_EXE)).find((p) => o.exists(p));
}

/** `sc.exe query <name>`: 0 installed, 1060 (ERROR_SERVICE_DOES_NOT_EXIST) not installed. */
export async function probeService(
  run: Runner,
  name: string,
  systemRoot = process.env.SystemRoot ?? "C:\\Windows",
): Promise<"installed" | "notInstalled" | "unknown"> {
  const res = await run(join(systemRoot, "System32", "sc.exe"), ["query", name]);
  if (res.code === 0) return "installed";
  if (res.code === 1060) return "notInstalled";
  // Access denied: it exists, this account may just not read it.
  if (res.code === 5) return "installed";
  return "unknown";
}

export interface SandboxPcWiring {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  psycheHome: string;
  /** `%LOCALAPPDATA%`. */
  localAppData: string;
  run: Runner;
  exists: (path: string) => boolean;
  restartHelper: () => Promise<void>;
  onState: (s: SandboxPcState) => void;
  env?: NodeJS.ProcessEnv;
}

export function createSandboxPc(w: SandboxPcWiring): SandboxPc {
  const env = w.env ?? process.env;
  const serviceExe = serviceExeFor(w);
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return new SandboxPc({
    platform: w.platform,
    ownerSid: () => (w.platform === "win32" ? currentUserSid() : null),
    psycheHome: w.psycheHome,
    imagesRoot: join(w.localAppData, "Psyche", "vm-images"),
    serviceExe,
    requireSignature: w.packaged,
    signatureOf: (exe) => authenticodeStatus(exe, w.run, systemRoot),
    probeService: (name) => probeService(w.run, name, systemRoot),
    // The images are read by the SYSTEM service and must not be writable by anyone else.
    restrictFolder: async (dir, sid) => {
      mkdirSync(dir, { recursive: true });
      const res = await w.run(join(systemRoot, "System32", "icacls.exe"), [
        dir,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "/grant:r",
        "*S-1-5-18:(OI)(CI)F",
      ]);
      if (res.code !== 0)
        throw new Error("Could not restrict the guest image folder to your account");
    },
    restartHelper: w.restartHelper,
    // Only an unpackaged (development) run may point at another manifest.
    manifestUrl: (!w.packaged && env.PSYCHE_VM_IMAGE_MANIFEST) || DEFAULT_MANIFEST_URL,
    listDir: (dir) => readdirSync(dir),
    onState: w.onState,
    log: (m) => console.warn(`[sandbox-pc] ${m}`),
  });
}

export { serviceNameFor };
