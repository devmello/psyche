import { describe, expect, it } from "vitest";
import { carryDesktopEnv, renderLaunchAgentPlist } from "../src/supervisor.ts";

/** `psyche start` must not undo what the desktop put in the agent's environment (review L3). */

const program = "/Applications/Psyche.app/Contents/Resources/psyched/psyched";
const input = { program, psycheHome: "/Users/me/.psyche" };
const desktop = renderLaunchAgentPlist(input).replace(
  /(<key>EnvironmentVariables<\/key>\s*<dict>)/,
  (m) =>
    `${m}\n    <key>PSYCHE_VAULT_KEY_FILE</key>\n    <string>/Users/me/.psyche/secrets/vault.key</string>\n    <key>PSYCHE_BUILD</key>\n    <string>abc123</string>`,
);

describe("carryDesktopEnv", () => {
  it("keeps the vault key file and the build for the same program, and is idempotent", () => {
    const once = carryDesktopEnv(renderLaunchAgentPlist(input), desktop);
    expect(once).toBe(desktop);
    expect(carryDesktopEnv(once, once)).toBe(once);
  });

  it("drops them for another program, or when nothing is installed", () => {
    const other = renderLaunchAgentPlist({ ...input, program: "/usr/local/bin/psyched" });
    expect(carryDesktopEnv(other, desktop)).toBe(other);
    expect(carryDesktopEnv(other, undefined)).toBe(other);
    expect(carryDesktopEnv(other, "")).toBe(other);
  });

  it("carries only the two variables, never anything else in the installed file", () => {
    const sneaky = desktop.replace(
      "<key>PATH</key>",
      "<key>PSYCHE_EVIL</key>\n    <string>1</string>\n    <key>PATH</key>",
    );
    expect(carryDesktopEnv(renderLaunchAgentPlist(input), sneaky)).not.toContain("PSYCHE_EVIL");
  });
});
