import { join } from "node:path";

/**
 * The systemd unit text (Linux desktop design §2.3, §4.4). One renderer for the desktop app and
 * the CLI (`apps/cli/src/supervisor.ts` imports it), so the two write the same bytes for the same
 * input and never rewrite each other's file. No imports beyond `node:path`: the CLI bundles it.
 *
 * - `server` profile: what `psyche start` has always written. Byte-identical to
 *   `deploy/systemd/psyche-gateway.service`.
 * - `desktop` profile (design §2.3): `After=default.target` (not `PartOf=graphical-session.target`:
 *   the Gateway also runs headless), `PSYCHE_BUILD` for the content check, `MemoryHigh` as a
 *   throttle and no `MemoryMax`, because an OOM kill in the middle of a migration is worse than
 *   slowness.
 */

export const GATEWAY_UNIT = "psyche-gateway.service";
export const HELPER_UNIT = "psyche-helper.service";

/** Set in the desktop profile's header so a reader can tell who owns the file. */
export const DESKTOP_UNIT_MARKER = "# Managed by the Psyche desktop app";

/**
 * `MemoryHigh` of the desktop profile. A starting value from the design; PR L1's plan is to
 * replace it with a number measured from idle psyched on Linux (test plan §13 step 1).
 */
export const DEFAULT_MEMORY_HIGH = "768M";

export type UnitProfile = "server" | "desktop";

export interface GatewayUnitInput {
  /** Absolute path of the `psyched` executable (or of an AppImage run with `--psyched`). */
  program: string;
  args?: readonly string[];
  /** Left out, psyched uses `~/.psyche` (the packaged unit has no way to name the home folder). */
  psycheHome?: string;
  profile?: UnitProfile;
  /** desktop: the Gateway build this app ships; a new build changes the unit, so it restarts. */
  build?: string;
  /** desktop: `PSYCHE_VAULT_KEY_FILE`, the key-file slot (design §10.1). */
  vaultKeyFile?: string;
  /** desktop: `MemoryHigh=`, default {@link DEFAULT_MEMORY_HIGH}. */
  memoryHigh?: string;
}

/**
 * systemd quoting: double quotes with backslash and quote escaped, `%` doubled (specifiers);
 * `$` doubled only in ExecStart=, where systemd expands variables.
 */
export function sdQuote(s: string, exec = false): string {
  let v = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (exec) v = v.replace(/\$/g, "$$$$");
  return `"${v}"`;
}

/** Inverse of {@link sdQuote} for one quoted token. */
function sdUnquote(token: string, exec = false): string {
  const v = token.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
  return exec ? v.replace(/\$\$/g, "$") : v;
}

function execLine(program: string, args: readonly string[] | undefined): string {
  return [program, ...(args ?? [])].map((a) => sdQuote(a, true)).join(" ");
}

function envLines(env: [string, string | undefined][]): string {
  return env
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
}

export function renderGatewayUnit(input: GatewayUnitInput): string {
  const exec = execLine(input.program, input.args);
  if ((input.profile ?? "server") === "server") {
    const env = envLines([["PSYCHE_HOME", input.psycheHome]]);
    return `# Psyche Gateway as a systemd user service. See deploy/README.md.
# Install: psyche start (writes this file), or copy it to ~/.config/systemd/user/ and run
#   systemctl --user daemon-reload && systemctl --user enable --now ${GATEWAY_UNIT}
# Keep it running after logout: loginctl enable-linger "$USER"
[Unit]
Description=Psyche Gateway (psyched)
Documentation=https://github.com/devmello/psyche/blob/main/deploy/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${env === "" ? "" : `${env}\n`}Restart=on-failure
RestartSec=5
TimeoutStopSec=20
# Files 0600, directories 0700 (security §14).
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
RestrictSUIDSGID=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  }
  const env = envLines([
    ["PSYCHE_HOME", input.psycheHome],
    ["PSYCHE_BUILD", input.build],
    ["PSYCHE_VAULT_KEY_FILE", input.vaultKeyFile],
  ]);
  return `${DESKTOP_UNIT_MARKER}: it rewrites this file when its content changes.
# Not part of graphical-session.target on purpose: the Gateway also runs headless.
[Unit]
Description=Psyche Gateway (psyched)
Documentation=https://github.com/devmello/psyche/blob/main/deploy/README.md
After=default.target

[Service]
Type=simple
ExecStart=${exec}
${env === "" ? "" : `${env}\n`}Restart=on-failure
RestartSec=5
TimeoutStopSec=20
# Files 0600, directories 0700 (security §14).
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
RestrictSUIDSGID=yes
# A throttle, never a kill: no MemoryMax (design §2.3).
MemoryHigh=${input.memoryHigh ?? DEFAULT_MEMORY_HIGH}

[Install]
WantedBy=default.target
`;
}

/**
 * The drop-in the desktop writes next to a PACKAGED unit (deb and rpm own the unit file itself,
 * under `/usr/lib/systemd/user`): the per-machine values the package cannot know. Same
 * content-change rule as the unit.
 */
export function renderGatewayDropIn(input: {
  psycheHome?: string;
  build?: string;
  vaultKeyFile?: string;
}): string {
  const env = envLines([
    ["PSYCHE_HOME", input.psycheHome],
    ["PSYCHE_BUILD", input.build],
    ["PSYCHE_VAULT_KEY_FILE", input.vaultKeyFile],
  ]);
  return `${DESKTOP_UNIT_MARKER}: it rewrites this file when its content changes.
[Service]
${env === "" ? "" : `${env}\n`}`;
}

export interface HelperUnitInput {
  /** Absolute path of `psyche-helper`, or of the AppImage run with its helper argument. */
  program: string;
  args?: readonly string[];
  psycheHome?: string;
}

/**
 * `psyche-helper.service` (design §4.4): started on demand by psyched with
 * `systemctl --user start`, so it has no `[Install]` section and costs nothing at rest.
 * `PartOf`/`After=graphical-session.target` because it needs a display. No sandboxing keys on
 * purpose: apps the helper launches inherit them (`NoNewPrivileges` would break a setuid
 * chrome-sandbox, `UMask=0077` would make the owner's own apps write 0600 files).
 */
export function renderHelperUnit(input: HelperUnitInput): string {
  const env = envLines([["PSYCHE_HOME", input.psycheHome]]);
  return `${DESKTOP_UNIT_MARKER}, or packaged next to the Gateway's unit.
# Started on demand by psyched (systemctl --user start ${HELPER_UNIT}); no [Install] section.
[Unit]
Description=Psyche Helper (computer use, on demand)
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=${execLine(input.program, input.args)}
${env === "" ? "" : `${env}\n`}Restart=no
`;
}

/** `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`): where the owner's units live. */
export function userUnitDir(env: NodeJS.ProcessEnv, home: string): string {
  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  return join(base, "systemd", "user");
}

export interface ParsedGatewayUnit {
  program?: string;
  args: string[];
  env: Record<string, string>;
  profile: UnitProfile;
}

/** What a unit written by {@link renderGatewayUnit} says; undefined for text with no `ExecStart=`. */
export function parseGatewayUnit(text: string): ParsedGatewayUnit | undefined {
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1];
  if (exec === undefined) return undefined;
  const tokens = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => sdUnquote(m[1] ?? "", true));
  const env: Record<string, string> = {};
  for (const m of text.matchAll(/^Environment="((?:[^"\\]|\\.)*)"$/gm)) {
    const pair = sdUnquote(m[1] ?? "");
    const eq = pair.indexOf("=");
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const [program, ...args] = tokens;
  return {
    ...(program === undefined ? {} : { program }),
    args,
    env,
    profile: text.includes(DESKTOP_UNIT_MARKER) ? "desktop" : "server",
  };
}
