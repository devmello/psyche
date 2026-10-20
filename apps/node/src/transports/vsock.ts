import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PsycheError } from "@psyche/protocol";
import type { FrameChannel } from "./channel.ts";
import { NdjsonChannel } from "./ndjson.ts";

/**
 * vsock to the host when psyche-node runs inside a VM guest (architecture §7, §10). Node has no
 * `AF_VSOCK`, so the stream goes through a bridge process that connects to `cid:port` and
 * relays bytes on stdio; frames are NDJSON exactly like the Gateway's node socket. The host
 * side (the VM manager's `VZVirtioSocketListener`) forwards accepted streams to the Gateway's
 * node socket.
 *
 * Bridges: `socat - VSOCK-CONNECT:<cid>:<port>` on Linux guests; on macOS guests the bridge
 * command is configured explicitly (`PSYCHE_NODE_VSOCK_BRIDGE`), since macOS ships no vsock CLI.
 * `{cid}` and `{port}` in the configured command are substituted.
 */
export interface VsockEndpoint {
  /** Host CID; 2 (`VMADDR_CID_HOST`) is the host as seen from a guest. */
  cid: number;
  port: number;
  /** argv template, e.g. `["socat", "-", "VSOCK-CONNECT:{cid}:{port}"]`. */
  bridge?: string[];
}

export const VMADDR_CID_HOST = 2;

export interface GuestProbe {
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  sysctl(name: string): string | null;
}

export const systemProbe: GuestProbe = {
  platform: process.platform,
  exists: existsSync,
  sysctl(name) {
    const r = spawnSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8", timeout: 2_000 });
    return r.status === 0 ? r.stdout.trim() : null;
  },
};

/** True when this process runs inside a virtual machine that can reach the host over vsock. */
export function detectVmGuest(probe: GuestProbe = systemProbe): boolean {
  if (probe.platform === "linux") return probe.exists("/dev/vsock");
  if (probe.platform === "darwin") return probe.sysctl("kern.hv_vmm_present") === "1";
  return false;
}

export function defaultBridge(platform: NodeJS.Platform = process.platform): string[] | null {
  return platform === "linux" ? ["socat", "-", "VSOCK-CONNECT:{cid}:{port}"] : null;
}

export function bridgeArgv(endpoint: VsockEndpoint, platform = process.platform): string[] {
  const template = endpoint.bridge ?? defaultBridge(platform);
  if (!template || template.length === 0) {
    throw new PsycheError(
      "unavailable",
      "no vsock bridge for this platform; set PSYCHE_NODE_VSOCK_BRIDGE",
    );
  }
  return template.map((part) =>
    part.replaceAll("{cid}", String(endpoint.cid)).replaceAll("{port}", String(endpoint.port)),
  );
}

/** Starts the bridge and resolves once it is running; its exit closes the channel. */
export function openVsock(endpoint: VsockEndpoint): Promise<FrameChannel> {
  const argv = bridgeArgv(endpoint);
  const [command, ...args] = argv as [string, ...string[]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      const channel = new NdjsonChannel(
        `vsock:${endpoint.cid}:${endpoint.port}`,
        child.stdout,
        child.stdin,
        () => child.kill("SIGTERM"),
      );
      child.once("exit", (code) => channel.close(`vsock bridge exited (${code ?? "signal"})`));
      resolve(channel);
    });
  });
}
