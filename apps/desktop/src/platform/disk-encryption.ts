import type { Runner } from "./runner.ts";

/**
 * The full-disk-encryption check onboarding runs (design §10.1). The Gateway's vault key is a
 * 0600 key file on Linux, and the Secret Service has no per-app access control, so protection at
 * rest comes from the disk: LUKS on `/` or on the volume holding the home folder. Onboarding
 * recommends it when it is missing, as FileVault is assumed on the Mac.
 */

export type DiskEncryption =
  | { status: "encrypted"; mount: string }
  | { status: "not_encrypted"; mount: string }
  | { status: "unknown" };

interface LsblkNode {
  type?: string;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  children?: LsblkNode[];
}

export const LSBLK_ARGV = ["-J", "-s", "-o", "TYPE,MOUNTPOINT"] as const;

function mountsOf(node: LsblkNode): string[] {
  const list = [...(node.mountpoints ?? []), node.mountpoint ?? null];
  return list.filter((m): m is string => typeof m === "string" && m !== "");
}

function hasCrypt(node: LsblkNode): boolean {
  return node.type === "crypt" || (node.children ?? []).some(hasCrypt);
}

function covers(mount: string, home: string): boolean {
  return mount === "/" || home === mount || home.startsWith(`${mount}/`);
}

/**
 * `lsblk -J -s -o TYPE,MOUNTPOINT` lists each device with the devices it sits on as `children`
 * (`-s`, inverse). The volume that holds `home` is the longest mount point that covers it; it is
 * encrypted when that device or anything under it is `crypt` (LUKS, including LVM on LUKS).
 */
export function parseLsblk(json: string, home: string): DiskEncryption {
  let tree: { blockdevices?: LsblkNode[] };
  try {
    tree = JSON.parse(json) as { blockdevices?: LsblkNode[] };
  } catch {
    return { status: "unknown" };
  }
  let best: { mount: string; node: LsblkNode } | undefined;
  for (const node of tree.blockdevices ?? []) {
    for (const mount of mountsOf(node)) {
      if (covers(mount, home) && (best === undefined || mount.length > best.mount.length)) {
        best = { mount, node };
      }
    }
  }
  if (best === undefined) return { status: "unknown" };
  return { status: hasCrypt(best.node) ? "encrypted" : "not_encrypted", mount: best.mount };
}

export async function checkDiskEncryption(run: Runner, home: string): Promise<DiskEncryption> {
  const res = await run("lsblk", [...LSBLK_ARGV]);
  if (res.code !== 0) return { status: "unknown" };
  return parseLsblk(res.stdout, home);
}
