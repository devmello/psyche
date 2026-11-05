// Reads the Electron fuses of a packaged app, with no dependency (the release `sign` job runs this
// while a signing keychain exists and must run no third-party code, so it does not use @electron/fuses).
//
//   node deploy/scripts/read-fuses.mjs <Psyche.app> [--expect Name=on|off]...
//
// Prints one line per fuse ("RunAsNode is Disabled", as `electron-fuses read` does) and exits 1 when an
// --expect does not hold or the fuse wire is missing. The wire is the sentinel string in the Electron
// Framework binary followed by a version byte, a length byte, and one byte per fuse: "1" enabled, "0"
// disabled, "r" removed (apps/desktop/forge.config.ts flips them at package time).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
/** Fuse order of wire version 1. */
export const FUSES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
];

/** `{name: "Enabled"|"Disabled"|"Removed"}` from a binary's bytes. */
export function parseFuses(buf) {
  const at = buf.indexOf(SENTINEL);
  if (at < 0) throw new Error("no fuse wire in this binary");
  const version = buf[at + SENTINEL.length];
  if (version !== 1) throw new Error(`unknown fuse wire version ${version}`);
  const length = buf[at + SENTINEL.length + 1];
  const out = {};
  for (let i = 0; i < length; i++) {
    const byte = buf[at + SENTINEL.length + 2 + i];
    const state =
      byte === 0x31
        ? "Enabled"
        : byte === 0x30
          ? "Disabled"
          : byte === 0x72
            ? "Removed"
            : "Unknown";
    out[FUSES[i] ?? `Fuse${i}`] = state;
  }
  return out;
}

export function readAppFuses(app) {
  const framework = join(
    app,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Electron Framework",
  );
  return parseFuses(readFileSync(framework));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const app = args.find((a) => !a.startsWith("--") && !/^[A-Za-z]+=(on|off)$/.test(a));
  const expects = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--expect") expects.push(args[i + 1]);
  if (!app) {
    process.stderr.write("usage: read-fuses.mjs <Psyche.app> [--expect Name=on|off]...\n");
    process.exit(2);
  }
  let fuses;
  try {
    fuses = readAppFuses(app);
  } catch (err) {
    process.stderr.write(`read-fuses: ${err.message}\n`);
    process.exit(1);
  }
  for (const [name, state] of Object.entries(fuses))
    process.stdout.write(`  ${name} is ${state}\n`);
  let bad = 0;
  for (const e of expects) {
    const [name, want] = String(e).split("=");
    const have = fuses[name];
    const ok = want === "on" ? have === "Enabled" : want === "off" ? have === "Disabled" : false;
    if (!ok) {
      process.stderr.write(`FAIL fuse ${name} is ${have ?? "missing"}, expected ${want}\n`);
      bad = 1;
    }
  }
  process.exit(bad);
}
