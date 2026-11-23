import { describe, expect, it } from "vitest";
import { renderSystemdUnit } from "../src/supervisor.ts";
import { renderGatewayUnit } from "../src/systemd-unit.ts";

/**
 * `psyche start` and the desktop app write the unit from one renderer
 * (apps/cli/src/systemd-unit.ts). The server output is pinned here byte for byte, as
 * it was before the renderer moved, so a server install never sees its unit change.
 */

const SERVER_UNIT = `# Psyche Gateway as a systemd user service. See deploy/README.md.
# Install: psyche start (writes this file), or copy it to ~/.config/systemd/user/ and run
#   systemctl --user daemon-reload && systemctl --user enable --now psyche-gateway.service
# Keep it running after logout: loginctl enable-linger "$USER"
[Unit]
Description=Psyche Gateway (psyched)
Documentation=https://github.com/devmello/psyche/blob/main/deploy/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="/usr/local/bin/psyched"
Environment="PSYCHE_HOME=/home/you/.psyche"
Restart=on-failure
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

describe("the CLI's systemd unit", () => {
  it("server profile output is byte-identical to what it always wrote", () => {
    expect(
      renderSystemdUnit({ program: "/usr/local/bin/psyched", psycheHome: "/home/you/.psyche" }),
    ).toBe(SERVER_UNIT);
  });

  it("an unchanged server unit stays the same when the CLI sees its own file again", () => {
    const input = { program: "/usr/local/bin/psyched", psycheHome: "/home/you/.psyche" };
    expect(renderSystemdUnit(input, SERVER_UNIT)).toBe(SERVER_UNIT);
  });

  it("quotes and escapes exactly as before", () => {
    const unit = renderSystemdUnit({
      program: "/opt/psyche $HOME/bin/psyched",
      args: ["--flag=50%", 'say "hi"'],
      psycheHome: "/home/me/.psyche %h",
    });
    expect(unit).toContain(
      'ExecStart="/opt/psyche $$HOME/bin/psyched" "--flag=50%%" "say \\"hi\\""',
    );
    expect(unit).toContain('Environment="PSYCHE_HOME=/home/me/.psyche %%h"');
  });

  it("keeps the desktop's profile, build and key file when it rewrites the desktop's unit", () => {
    const installed = renderGatewayUnit({
      program: "/a/Psyche.AppImage",
      args: ["--psyched"],
      psycheHome: "/home/me/.psyche",
      profile: "desktop",
      appImage: true,
      build: "b9",
      vaultKeyFile: "/home/me/.psyche/secrets/vault.key",
      memoryHigh: "1G",
    });
    const rewritten = renderSystemdUnit(
      { program: "/a/Psyche.AppImage", args: ["--psyched"], psycheHome: "/home/me/.psyche" },
      installed,
    );
    // Same program and home: the desktop's file comes back unchanged, so neither side fights.
    expect(rewritten).toBe(installed);
  });

  it("keeps an AppImage desktop unit without the no_new_privs lines when the CLI rewrites it", () => {
    const installed = renderGatewayUnit({
      program: "/a/Psyche.AppImage",
      args: ["--psyched"],
      psycheHome: "/home/me/.psyche",
      profile: "desktop",
      build: "b9",
      appImage: true,
    });
    expect(installed).not.toContain("NoNewPrivileges=yes");
    const rewritten = renderSystemdUnit(
      { program: "/a/Psyche.AppImage", args: ["--psyched"], psycheHome: "/home/me/.psyche" },
      installed,
    );
    expect(rewritten).toBe(installed);
  });

  const THREE = ["NoNewPrivileges=yes", "LockPersonality=yes", "RestrictSUIDSGID=yes"];
  const appImageUnit = renderGatewayUnit({
    program: "/a/Psyche.AppImage",
    args: ["--psyched"],
    psycheHome: "/home/me/.psyche",
    profile: "desktop",
    build: "b9",
    appImage: true,
  });

  it("a plain psyched written over the AppImage's unit gets all three lines back", () => {
    const rewritten = renderSystemdUnit(
      { program: "/usr/local/bin/psyched", args: [], psycheHome: "/home/me/.psyche" },
      appImageUnit,
    );
    expect(rewritten).toContain('ExecStart="/usr/local/bin/psyched"');
    for (const k of THREE) expect(rewritten).toContain(k);
    const noArgs = renderSystemdUnit(
      { program: "/usr/local/bin/psyched", psycheHome: "/home/me/.psyche" },
      appImageUnit,
    );
    for (const k of THREE) expect(noArgs).toContain(k);
  });

  it("a desktop unit with a respelled NoNewPrivileges=true and a plain program keeps all three", () => {
    const respelled = renderGatewayUnit({
      program: "/usr/local/bin/psyched",
      psycheHome: "/home/me/.psyche",
      profile: "desktop",
    }).replace("NoNewPrivileges=yes", "NoNewPrivileges=true");
    const rewritten = renderSystemdUnit(
      { program: "/usr/local/bin/psyched", psycheHome: "/home/me/.psyche" },
      respelled,
    );
    for (const k of THREE) expect(rewritten).toContain(k);
  });

  it("renderGatewayUnit with appImage but no --psyched keeps all three", () => {
    const unit = renderGatewayUnit({
      program: "/a/Psyche.AppImage",
      args: [],
      profile: "desktop",
      appImage: true,
    });
    for (const k of THREE) expect(unit).toContain(k);
  });
});
