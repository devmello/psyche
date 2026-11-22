// Builds the psyche-server packages: a headless Linux Host with no Electron
// (docs/design/linux-helper-only-2026.md §3.2, §7; wave B1).
//
//   node deploy/linux-server/build.mjs --bundle <psyched dir> --helper <psyche-helper>
//        --version <1.2.3> --arch arm64|x64 --out <dir>
//        [--formats deb,rpm,tar.zst] [--release-keys <release-keys.ts|keys.json>]
//        [--headless-unit <psyche-helper-headless.service>]
//
// --bundle is a Linux build of deploy/scripts/build-psyched.mjs (psyched, the CLI and their Node),
// --helper the release build of apps/linux-helper. Writes, named as update-manifest.mjs expects:
//   psyche-server-<version>-linux-<arch>.deb       dpkg-deb (dpkg)
//   psyche-server-<version>-linux-<arch>.rpm       rpmbuild (rpm)
//   psyche-server-<version>-linux-<arch>.tar.zst   tar, compressed with Node's own zstd
//
// deb and rpm install, all root-owned:
//   /usr/lib/psyche-server/psyched/                the bundled Gateway and CLI with their Node
//   /usr/lib/psyche-server/psyche-helper           the Host helper: the peer check's second
//                                                  packaged path (LINUX_PACKAGED_HELPER_PATHS)
//   /usr/lib/psyche-server/release-keys.json       the keys `psyche update` trusts
//   /usr/lib/psyche-server/psyche-server.json      what this install is (kind, version, arch)
//   /usr/bin/psyche, /usr/bin/psyched              links into psyched/
//   /usr/lib/systemd/user/psyche-gateway.service   apps/cli/src/systemd-unit.ts's server unit
//   /usr/lib/systemd/user/psyche-helper-headless.service
//                                                  B0's unit (deploy/systemd/), run from this
//                                                  package's helper
// and `Conflicts: psyche`, the desktop package: two Gateways cannot share ~/.psyche. The postinst
// turns on linger for the user who ran `sudo` (design §3.3: the one admin step) and says how to
// start the Gateway. The tarball holds the same files plus install.sh for an install under the
// owner's own account (deploy/linux-server/install.mjs), which `psyche update` replaces in place.
//
// Release keys default to the desktop's TRUSTED_RELEASE_KEYS (apps/desktop/src/main/release-keys.ts,
// public keys only). Tests pass a throwaway key's JSON instead.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createZstdCompress, constants as zlib } from "node:zlib";
import { keyIdOf, loadTrustedKeys, serverArtifactName } from "../scripts/update-manifest.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const HERE = join(ROOT, "deploy", "linux-server");

export const PACKAGE = "psyche-server";
/** The desktop package (deploy/linux, PR #1274): never on the same computer as this one. */
export const DESKTOP_PACKAGE = "psyche";
export const SERVER_ROOT = "/usr/lib/psyche-server";
export const SERVER_HELPER = `${SERVER_ROOT}/psyche-helper`;
export const HEADLESS_UNIT = "psyche-helper-headless.service";
export const GATEWAY_UNIT = "psyche-gateway.service";
export const MAINTAINER = "Psyche <devmello@users.noreply.github.com>";
export const HOMEPAGE = "https://github.com/devmello/psyche";
export const SUMMARY = "Psyche Gateway for a Linux computer without a screen";
export const DESCRIPTION =
  "Runs Psyche's Gateway (psyched) and its helper as a headless Host. Connect the Psyche desktop app to it from another computer.";
/**
 * Runtime needs: glibc and libstdc++ (Node, the addons), PipeWire's client library (the helper
 * links it), and what the helper's private screen needs (§3.1: Xvfb, a session bus, AT-SPI, xauth,
 * bubblewrap for contained commands).
 */
export const DEB_DEPENDS = [
  "libc6 (>= 2.35)",
  "libstdc++6",
  "libpipewire-0.3-0t64 | libpipewire-0.3-0",
  "xvfb",
  "xauth",
  "dbus-user-session",
  "at-spi2-core",
  "bubblewrap",
];
/**
 * Not required, but wanted: a server has no mDNS responder by default, and the LAN pairing link
 * names `https://<hostname>.local:7979`, which a Mac cannot resolve without one.
 */
export const DEB_RECOMMENDS = ["avahi-daemon"];
export const RPM_RECOMMENDS = ["avahi"];
export const RPM_REQUIRES = [
  "glibc >= 2.35",
  "libstdc++",
  "pipewire-libs",
  "xorg-x11-server-Xvfb",
  "xorg-x11-xauth",
  "dbus",
  "at-spi2-core",
  "bubblewrap",
];

const ARCHES = {
  arm64: { deb: "arm64", rpm: "aarch64", elf: "ARM aarch64" },
  x64: { deb: "amd64", rpm: "x86_64", elf: "x86-64" },
};
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** deb and rpm sort `1.2.0~alpha.0` before `1.2.0`; a hyphen would sort it after. */
export function packageVersion(version) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  return version.replace("-", "~");
}

/** `{ keyId, publicKey }[]` from release-keys.ts (imported, as the app evaluates it) or a JSON list. */
export async function releaseKeys(file) {
  if (/\.(ts|mjs|js)$/.test(file)) return loadTrustedKeys(file);
  const list = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${file}: not a list of release keys`);
  return list.map((k, i) => {
    const ok =
      k !== null &&
      typeof k === "object" &&
      Object.keys(k).sort().join(",") === "keyId,publicKey" &&
      /^[0-9a-f]{16}$/.test(k.keyId) &&
      /^[A-Za-z0-9+/]{43}=$/.test(k.publicKey) &&
      keyIdOf(Buffer.from(k.publicKey, "base64")) === k.keyId;
    if (!ok) throw new Error(`${file}: entry ${i} is not a valid { keyId, publicKey }`);
    return { keyId: k.keyId, publicKey: k.publicKey };
  });
}

/**
 * B0's headless helper unit, run from `helperPath`: its one ExecStart's program (a path ending in
 * `/psyche-helper`, quoted or not) is replaced, its arguments kept. Anything else is an error, so
 * a changed unit cannot ship pointing at the desktop package's helper.
 */
export function headlessUnitFor(text, helperQuoted) {
  const lines = text.split("\n");
  const at = lines.flatMap((l, i) => (/^\s*ExecStart\s*=/.test(l) ? [i] : []));
  if (at.length !== 1)
    throw new Error(`${HEADLESS_UNIT} must have exactly one ExecStart, has ${at.length}`);
  const i = at[0];
  const value = lines[i].replace(/^\s*ExecStart\s*=\s*/, "");
  const m = /^("(?:[^"\\]|\\.)*"|\S+)(.*)$/.exec(value);
  const program = m?.[1].startsWith('"') ? m[1].slice(1, -1) : m?.[1];
  if (!m || program === undefined || !/(^|\/)psyche-helper$/.test(program))
    throw new Error(`${HEADLESS_UNIT}: ExecStart does not start psyche-helper (${value})`);
  lines[i] = `ExecStart=${helperQuoted}${m[2]}`;
  return lines.join("\n");
}

/** systemd's quoting for a path in ExecStart (apps/cli/src/systemd-unit.ts sdQuote). */
const sdQuoteExec = (s) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** The two user units, for a helper and a psyched at fixed paths (deb, rpm) or under a placeholder. */
export async function renderUnits({ psyched, helper, headlessTemplate, quote = sdQuoteExec }) {
  const { renderGatewayUnit } = await import(
    pathToFileURL(join(ROOT, "apps/cli/src/systemd-unit.ts")).href
  );
  const gateway = renderGatewayUnit({ program: psyched });
  return {
    [GATEWAY_UNIT]: gateway,
    [HEADLESS_UNIT]: headlessUnitFor(headlessTemplate, quote(helper)),
  };
}

/**
 * The users whose systemd user manager runs (logged in, or lingering), uid 0 left out: a postinst
 * or prerm reaches their units with `systemctl --machine <user>@ --user`. A user whose manager is
 * not running has no Psyche unit running either.
 */
const USERS_WITH_MANAGER = `loginctl list-users --no-legend 2>/dev/null | awk '$1 != 0 { print $2 }'`;

export const POSTINST = `#!/bin/sh
# psyche-server postinst (deploy/linux-server/build.mjs). Never fails the install: a step that does
# not work prints what to run instead.
set -e
first=no
case "\${1:-configure}" in
  configure) [ -z "\${2:-}" ] && first=yes ;;
  1) first=yes ;;
  2) ;;
  *) exit 0 ;;
esac
if [ "$first" = yes ]; then
  u="\${SUDO_USER:-}"
  if [ -n "$u" ] && [ "$u" != root ] && command -v loginctl >/dev/null 2>&1; then
    # Linger (design §3.3), on the first install only: the user manager starts at boot, so Psyche
    # runs with nobody logged in. An upgrade never turns it on for whoever runs apt upgrade.
    if loginctl enable-linger "$u" 2>/dev/null; then
      echo "psyche-server: turned on linger for $u, so Psyche keeps running while nobody is logged in"
    else
      echo "psyche-server: could not turn on linger; run: sudo loginctl enable-linger $u" >&2
    fi
    h=$(getent passwd "$u" | cut -d: -f6)
    if [ -n "$h" ] && [ -e "$h/.config/systemd/user/${GATEWAY_UNIT}" ]; then
      echo "psyche-server: $h/.config/systemd/user/${GATEWAY_UNIT} overrides this package's unit (psyche start or a tarball install wrote it); remove it to use the package's" >&2
    fi
    systemctl --machine "$u@" --user daemon-reload >/dev/null 2>&1 || true
    # The setup code (remote-gateway design §3.6): this server is set up from the Psyche app on a
    # Mac on the same network, with a one-time code. Only a hash of it is kept, so it is shown
    # here, once; \`psyche setup code\` makes a new one. Then the Gateway starts, in claim mode.
    if [ -n "$h" ] && command -v runuser >/dev/null 2>&1 &&
      runuser -u "$u" -- env HOME="$h" /usr/bin/psyche setup code; then
      echo "psyche-server: in the Psyche app on your Mac, choose Connect to a Psyche server and type that code"
    else
      echo "psyche-server: for a setup code, as $u run: psyche setup code" >&2
    fi
    if systemctl --machine "$u@" --user enable --now ${GATEWAY_UNIT} >/dev/null 2>&1; then
      echo "psyche-server: started Psyche for $u"
    else
      echo "psyche-server: as $u, run: systemctl --user enable --now ${GATEWAY_UNIT}" >&2
    fi
  else
    echo "psyche-server: so Psyche keeps running while nobody is logged in, run: sudo loginctl enable-linger <user>"
    echo "psyche-server: as the user Psyche runs for: psyche setup code, then systemctl --user enable --now ${GATEWAY_UNIT}"
  fi
  exit 0
fi
# An upgrade: every running Gateway and headless helper restarts on the new files. A helper left
# running from the replaced file fails the Gateway's peer check (binary_replaced) until it does.
command -v systemctl >/dev/null 2>&1 || exit 0
for u in $(${USERS_WITH_MANAGER}); do
  systemctl --machine "$u@" --user daemon-reload >/dev/null 2>&1 || true
  if systemctl --machine "$u@" --user -q is-active ${GATEWAY_UNIT} ${HEADLESS_UNIT} 2>/dev/null; then
    systemctl --machine "$u@" --user try-restart ${GATEWAY_UNIT} ${HEADLESS_UNIT} >/dev/null 2>&1 ||
      echo "psyche-server: could not restart Psyche for $u; as $u: systemctl --user try-restart ${GATEWAY_UNIT} ${HEADLESS_UNIT}" >&2
    echo "psyche-server: restarted Psyche for $u on the new files"
  fi
done
exit 0
`;

export const PRERM = `#!/bin/sh
# psyche-server prerm: on removal, stop and disable the Gateway and helper of every user whose user
# manager runs (logged in, or lingering). A user whose manager is not running has nothing running;
# their enable links stay in ~/.config/systemd/user and point at nothing once the package is gone.
set -e
case "\${1:-remove}" in
  remove|0)
    command -v systemctl >/dev/null 2>&1 || exit 0
    for u in $(${USERS_WITH_MANAGER}); do
      systemctl --machine "$u@" --user disable --now ${GATEWAY_UNIT} ${HEADLESS_UNIT} >/dev/null 2>&1 || true
    done
    ;;
esac
exit 0
`;

export const POSTRM = `#!/bin/sh
# psyche-server postrm. Psyche's data is in each user's ~/.psyche and is never removed here.
set -e
case "\${1:-remove}" in
  remove|purge|0)
    echo "psyche-server: removed. Your data in ~/.psyche is untouched."
    ;;
esac
exit 0
`;

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** No file or directory in the tree is writable by group or other (the package is root's). */
function closeModes(dir) {
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    chmodSync(p, st.mode & 0o7755);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
  };
  walk(dir);
}

/** Checks the inputs: a Linux bundle of `arch` and an ELF helper of `arch`. */
export function checkInputs({ bundle, helper, arch }) {
  for (const f of ["psyched", "psyche", "runtime/node", "build-info.json"]) {
    if (!existsSync(join(bundle, f)))
      throw new Error(`${bundle} has no ${f}: not a psyched bundle`);
  }
  const info = JSON.parse(readFileSync(join(bundle, "build-info.json"), "utf8"));
  if (info.platform !== "linux" || info.arch !== arch)
    throw new Error(
      `${bundle} is a ${info.platform ?? "darwin"}-${info.arch} bundle, not linux-${arch}`,
    );
  const elf = execFileSync("file", ["-bL", helper], { encoding: "utf8" });
  if (!elf.startsWith("ELF 64-bit") || !elf.includes(ARCHES[arch].elf))
    throw new Error(`${helper} is not a ${arch} Linux binary: ${elf.trim()}`);
  return info;
}

/** The tree shared by deb and rpm, under `stage` (usr/...). */
function stagePackageTree(stage, { bundle, helper, keys, units, version, arch, kind }) {
  const lib = join(stage, "usr", "lib", "psyche-server");
  mkdirSync(lib, { recursive: true });
  cpSync(bundle, join(lib, "psyched"), { recursive: true, verbatimSymlinks: true });
  cpSync(helper, join(lib, "psyche-helper"));
  chmodSync(join(lib, "psyche-helper"), 0o755);
  writeFileSync(join(lib, "release-keys.json"), `${JSON.stringify(keys, null, 2)}\n`, {
    mode: 0o644,
  });
  writeFileSync(
    join(lib, "psyche-server.json"),
    `${JSON.stringify({ format: "psyche-server-install", kind, version, arch }, null, 2)}\n`,
    { mode: 0o644 },
  );
  const bin = join(stage, "usr", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync("../lib/psyche-server/psyched/psyche", join(bin, "psyche"));
  symlinkSync("../lib/psyche-server/psyched/psyched", join(bin, "psyched"));
  const unitDir = join(stage, "usr", "lib", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  for (const [name, text] of Object.entries(units))
    writeFileSync(join(unitDir, name), text, { mode: 0o644 });
  closeModes(stage);
}

function buildDeb(work, out, input) {
  const stage = join(work, "deb");
  stagePackageTree(stage, { ...input, kind: "deb" });
  const meta = join(stage, "DEBIAN");
  mkdirSync(meta);
  const size = Number(
    execFileSync("du", ["-sk", join(stage, "usr")], { encoding: "utf8" }).split(/\s/)[0],
  );
  writeFileSync(
    join(meta, "control"),
    [
      `Package: ${PACKAGE}`,
      `Version: ${packageVersion(input.version)}`,
      `Architecture: ${ARCHES[input.arch].deb}`,
      `Maintainer: ${MAINTAINER}`,
      `Installed-Size: ${size}`,
      `Depends: ${DEB_DEPENDS.join(", ")}`,
      `Recommends: ${DEB_RECOMMENDS.join(", ")}`,
      `Conflicts: ${DESKTOP_PACKAGE}`,
      "Section: net",
      "Priority: optional",
      `Homepage: ${HOMEPAGE}`,
      `Description: ${SUMMARY}`,
      ` ${DESCRIPTION}`,
      "",
    ].join("\n"),
  );
  for (const [name, text] of [
    ["postinst", POSTINST],
    ["prerm", PRERM],
    ["postrm", POSTRM],
  ])
    writeFileSync(join(meta, name), text, { mode: 0o755 });
  const file = join(out, serverArtifactName(input.version, input.arch, "deb"));
  run("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", stage, file]);
  return file;
}

function buildRpm(work, out, input) {
  const top = join(work, "rpm");
  const stage = join(top, "stage");
  stagePackageTree(stage, { ...input, kind: "rpm" });
  for (const d of ["BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS", "BUILDROOT"])
    mkdirSync(join(top, d), { recursive: true });
  const [v, pre] = packageVersion(input.version).split("~");
  // The deb scripts without their #! line. rpm passes the number of copies left installed (1 on
  // install, 2 on upgrade, 0 on removal) where dpkg passes a word; the cases accept both.
  const scriptlet = (sh) => sh.replace(/^#!\/bin\/sh\n/, "");
  const spec = `%global _build_id_links none
%global __strip /bin/true
%global __os_install_post %{nil}
%define debug_package %{nil}
%define _binary_payload w7T.xzdio

Name: ${PACKAGE}
Version: ${pre === undefined ? v : `${v}~${pre}`}
Release: 1
Summary: ${SUMMARY}
License: Apache-2.0
URL: ${HOMEPAGE}
BuildArch: ${ARCHES[input.arch].rpm}
Requires: ${RPM_REQUIRES.join(", ")}
Recommends: ${RPM_RECOMMENDS.join(", ")}
Conflicts: ${DESKTOP_PACKAGE}
AutoReqProv: no

%description
${DESCRIPTION}

%install
mkdir -p %{buildroot}
cp -a ${stage}/usr %{buildroot}/

%post
${scriptlet(POSTINST)}
%preun
${scriptlet(PRERM)}
%postun
${scriptlet(POSTRM)}
%files
%defattr(-,root,root,-)
${SERVER_ROOT}/
/usr/bin/psyche
/usr/bin/psyched
/usr/lib/systemd/user/${GATEWAY_UNIT}
/usr/lib/systemd/user/${HEADLESS_UNIT}
`;
  const specFile = join(top, "SPECS", `${PACKAGE}.spec`);
  writeFileSync(specFile, spec);
  run("rpmbuild", [
    "-bb",
    "--define",
    `_topdir ${top}`,
    "--target",
    ARCHES[input.arch].rpm,
    specFile,
  ]);
  const built = join(top, "RPMS", ARCHES[input.arch].rpm);
  const [name] = readdirSync(built).filter((n) => n.endsWith(".rpm"));
  if (!name) throw new Error("rpmbuild made no package");
  const file = join(out, serverArtifactName(input.version, input.arch, "rpm"));
  cpSync(join(built, name), file);
  return file;
}

/** `psyche-server-<v>-linux-<arch>/` for an install under the owner's account (install.mjs). */
async function buildTarball(work, out, input) {
  const name = serverArtifactName(input.version, input.arch, "tar.zst").replace(/\.tar\.zst$/, "");
  const dir = join(work, "tar", name);
  mkdirSync(dir, { recursive: true });
  cpSync(input.bundle, join(dir, "psyched"), { recursive: true, verbatimSymlinks: true });
  cpSync(input.helper, join(dir, "psyche-helper"));
  chmodSync(join(dir, "psyche-helper"), 0o755);
  writeFileSync(join(dir, "release-keys.json"), `${JSON.stringify(input.keys, null, 2)}\n`);
  writeFileSync(
    join(dir, "psyche-server.json"),
    `${JSON.stringify({ format: "psyche-server-install", kind: "tarball", version: input.version, arch: input.arch }, null, 2)}\n`,
  );
  cpSync(join(HERE, "install.mjs"), join(dir, "install.mjs"));
  writeFileSync(
    join(dir, "install.sh"),
    `#!/bin/sh
# Installs psyche-server under your own account (deploy/linux-server/install.mjs): no root needed,
# except for linger, which it asks for when it has to.
set -eu
if [ "$(id -u)" = 0 ]; then
  echo "psyche-server: do not run this as root (sudo): run it as the user Psyche runs for" >&2
  exit 1
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$here/psyched/runtime/node" "$here/install.mjs" install "$@"
`,
    { mode: 0o755 },
  );
  mkdirSync(join(dir, "units"));
  for (const [unit, text] of Object.entries(input.tarballUnits))
    writeFileSync(join(dir, "units", `${unit}.in`), text);
  closeModes(dir);
  const tar = join(work, `${name}.tar`);
  run("tar", [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mtime=@0",
    "-C",
    join(work, "tar"),
    "-cf",
    tar,
    name,
  ]);
  const file = join(out, `${name}.tar.zst`);
  await pipeline(
    createReadStream(tar),
    createZstdCompress({ params: { [zlib.ZSTD_c_compressionLevel]: 19 } }),
    createWriteStream(file),
  );
  return file;
}

export async function buildPackages(o) {
  const arch = o.arch;
  if (!ARCHES[arch]) throw new Error("--arch must be arm64 or x64");
  packageVersion(o.version);
  checkInputs(o);
  const keys = await releaseKeys(o.releaseKeys);
  if (keys.length === 0)
    throw new Error("no trusted release key: psyche update could verify nothing");
  if (!existsSync(o.headlessUnit))
    throw new Error(
      `${o.headlessUnit} is missing (wave B0 adds deploy/systemd/${HEADLESS_UNIT}); pass --headless-unit`,
    );
  const headlessTemplate = readFileSync(o.headlessUnit, "utf8");
  const units = await renderUnits({
    psyched: `${SERVER_ROOT}/psyched/psyched`,
    helper: SERVER_HELPER,
    headlessTemplate,
  });
  // The tarball's units name the release root through a placeholder install.mjs fills in, already
  // escaped for a quoted ExecStart; the placeholder itself needs no escaping.
  const { ROOT_PLACEHOLDER } = await import(pathToFileURL(join(HERE, "install.mjs")).href);
  const tarballUnits = await renderUnits({
    psyched: `${ROOT_PLACEHOLDER}/current/psyched/psyched`,
    helper: `${ROOT_PLACEHOLDER}/current/psyche-helper`,
    headlessTemplate,
  });
  mkdirSync(o.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "psyche-server-pkg-"));
  const input = { ...o, keys, units, tarballUnits };
  const made = [];
  try {
    for (const format of o.formats) {
      if (format === "deb") made.push(buildDeb(work, o.out, input));
      else if (format === "rpm") made.push(buildRpm(work, o.out, input));
      else if (format === "tar.zst") made.push(await buildTarball(work, o.out, input));
      else throw new Error(`unknown format ${format}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return made.map((file) => ({ file, sha256: sha256(file) }));
}

async function main(argv) {
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const need = (n) => {
    const v = opt(n);
    if (v === undefined) throw new Error(`${n} is required`);
    return v;
  };
  const made = await buildPackages({
    bundle: resolve(need("--bundle")),
    helper: resolve(need("--helper")),
    version: need("--version"),
    arch: need("--arch"),
    out: resolve(need("--out")),
    formats: (opt("--formats") ?? "deb,rpm,tar.zst").split(","),
    releaseKeys: resolve(
      opt("--release-keys") ?? join(ROOT, "apps/desktop/src/main/release-keys.ts"),
    ),
    headlessUnit: resolve(opt("--headless-unit") ?? join(ROOT, "deploy/systemd", HEADLESS_UNIT)),
  });
  for (const m of made) process.stdout.write(`${m.sha256}  ${m.file}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`linux-server build: ${err.message}\n`);
    process.exit(1);
  });
}
