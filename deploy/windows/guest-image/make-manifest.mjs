// Writes out/manifest.json and out/SHA256SUMS for the Windows guest image.
//   node make-manifest.mjs [outDir]
// Reads outDir/{vmlinuz,initrd,rootfs.vhdx,rootfs.vhdx.zst,sessiondata.vhdx,kernel-info.json,
// work/psyche-node.mjs}. Schema: README.md "manifest.json".
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const out = resolve(process.argv[2] ?? join(here, "out"));
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

const sha256 = (path) =>
  new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", fail)
      .on("end", () => ok(h.digest("hex")));
  });
const entry = async (name) => ({
  name,
  size: statSync(join(out, name)).size,
  sha256: await sha256(join(out, name)),
});

const guest = json(join(here, "guest-image.json"));
const kernelInfo = json(join(out, "kernel-info.json"));
const sandbox = json(join(repo, "deploy/sandbox-image/versions.json"));
const nodePkg = json(join(repo, "apps/node/package.json"));

const vmlinuz = await entry("vmlinuz");
const initrd = await entry("initrd");
const rootfs = await entry("rootfs.vhdx");
const rootfsZst = await entry("rootfs.vhdx.zst");
const sessiondata = await entry("sessiondata.vhdx");
const bundle = await sha256(join(out, "work", "psyche-node.mjs"));

const content = createHash("sha256")
  .update(`${vmlinuz.sha256}\n${initrd.sha256}\n${rootfs.sha256}\n`)
  .digest("hex")
  .slice(0, 8);
const imageVersion = `${guest.version}-${content}`;
const sessionGiB = Number(process.env.SESSION_GIB ?? guest.sessionDiskGiB);

// hvsocket service id for a Linux vsock port: <port as 8 hex digits>-facb-11e6-bd58-64006a7986d3.
const serviceId = (port) => `${port.toString(16).padStart(8, "0")}-facb-11e6-bd58-64006a7986d3`;

const manifest = {
  schema: 1,
  kind: "psyche-windows-guest-image",
  contract: 1,
  imageVersion,
  version: guest.version,
  arch: "x86_64",
  builtAt: new Date().toISOString(),
  files: {
    vmlinuz,
    initrd,
    rootfs: {
      ...rootfs,
      readOnly: true,
      format: "vhdx",
      subformat: "dynamic",
      compressed: { ...rootfsZst, format: "zstd" },
    },
    sessiondata: {
      ...sessiondata,
      format: "vhdx",
      subformat: "dynamic",
      template: true,
      virtualSizeBytes: sessionGiB * 1024 ** 3,
    },
  },
  boot: {
    kernelCmdline: guest.kernelCmdline,
    // Disks are found by ext4 label, not by LUN: attach order does not matter.
    disks: [
      { role: "rootfs", file: "rootfs.vhdx", label: "psyche-root", readOnly: true, bus: "scsi" },
      {
        role: "sessiondata",
        file: "sessiondata.vhdx",
        label: "psyche-data",
        readOnly: false,
        bus: "scsi",
      },
    ],
    console: "ttyS0 (HCS COM port 1)",
  },
  resources: guest.resources,
  guest: {
    user: "psyche",
    uid: 1000,
    hostCid: 2,
    gatewayVsockPort: guest.gatewayPort,
    gatewayHvSocketServiceId: serviceId(guest.gatewayPort),
    controlVsockPort: guest.controlPort,
    controlHvSocketServiceId: serviceId(guest.controlPort),
    plan9: {
      mountRoot: "/mnt/psyche",
      transport: "AF_VSOCK to host CID 2 (Hyper-V socket), 9P2000.L over trans=fd",
      defaultPort: 564,
      aname: "the share's AccessName (default: the share name)",
    },
    nodeHome: "/session/node",
    workspace: "/workspace",
    network: "none unless the host attaches an adapter; then DHCP",
  },
  kernel: kernelInfo,
  sandboxImage: {
    version: sandbox.version,
    variant: "base",
    nodeImage: sandbox.baseImages.node,
    uvImage: sandbox.baseImages.uv,
  },
  node: { package: nodePkg.name, version: nodePkg.version, bundleSha256: bundle },
  licenses: {
    kernel: "GPL-2.0-only",
    userland:
      "Debian packages under their own licenses; see packages.tsv and README.md (source offer)",
    psyche: "Apache-2.0",
  },
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const sums = [];
for (const name of [
  "vmlinuz",
  "initrd",
  "rootfs.vhdx",
  "rootfs.vhdx.zst",
  "sessiondata.vhdx",
  "manifest.json",
  "kernel.config",
  "kernel-info.json",
  "packages.tsv",
]) {
  sums.push(`${await sha256(join(out, name))}  ${name}`);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`manifest.json written: imageVersion ${imageVersion}`);
