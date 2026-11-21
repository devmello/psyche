import type { MachineInfo } from "@psyche/protocol";

/** A fixed clock for stories and tests ("2 minutes ago" stays 2 minutes ago). */
export const MACHINES_NOW = Date.parse("2026-11-19T12:00:00Z");

/** A healthy computer on the owner's own account: the base every row state starts from. */
export const LAB_BOX: MachineInfo = {
  id: "mch_lab",
  deviceId: "dev_lab",
  name: "lab-box",
  platform: "linux",
  status: "online",
  display: "headless",
  surfaces: ["virtual_screen"],
  exec: { enabled: true, contained: true },
  files: { roots: [{ path: "/home/dev/work", mode: "rw" }] },
  account: "own",
  policyOwner: "root",
  passwordlessSudo: false,
  helperVersion: "0.9.2",
  lastSeenAt: "2026-11-19T11:58:00Z",
};

const machine = (id: string, name: string, over: Partial<MachineInfo>): MachineInfo => ({
  ...LAB_BOX,
  id: `mch_${id}`,
  deviceId: `dev_${id}`,
  name,
  ...over,
});

export const OFFLINE_BOX = machine("off", "attic-pc", {
  status: "offline",
  lastSeenAt: "2026-11-18T20:30:00Z",
});
export const OUTDATED_BOX = machine("old", "old-laptop", { helperVersion: "0.8.4" });
export const DEDICATED_BOX = machine("ded", "build-server", {
  account: "dedicated",
  files: { roots: [] },
});
export const FULL_SHELL_BOX = machine("full", "dev-vm", {
  exec: { enabled: true, contained: false },
});
export const USER_LIMITS_BOX = machine("tar", "tarball-box", { policyOwner: "user" });
export const SUDO_BOX = machine("sudo", "workstation", { passwordlessSudo: true });

export const IDENTITIES = Object.fromEntries(
  [
    LAB_BOX,
    OFFLINE_BOX,
    OUTDATED_BOX,
    DEDICATED_BOX,
    FULL_SHELL_BOX,
    USER_LIMITS_BOX,
    SUDO_BOX,
  ].map((m, i) => [
    m.deviceId,
    { publicKey: `aGVsbG8${i}d29ybGRfZGV2aWNla2V5`, pairedAt: "2026-11-12T09:00:00Z" },
  ]),
);
