import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appCap, TERMINAL_IDE_APPS } from "../src/apps.ts";

/**
 * The Gateway's click-only list and the Mac helper's (`FixedCaps.terminalsAndIDEs`) must name the
 * same apps: the card is decided here, the action there (apps.open review, finding 5).
 */
function helperTerminals(): string[] {
  const swift = readFileSync(
    new URL(
      "../../../apps/mac-helper/Sources/PsycheHelperCore/Computer/Tiers.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const block = /static let terminalsAndIDEs = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** The helper's `com.jetbrains.` prefix is the Gateway's `com.jetbrains.*`. */
const asGateway = (id: string) => (id.endsWith(".") ? `${id}*` : id).toLowerCase();

describe("terminal and IDE caps", () => {
  it("lists every app the Mac helper caps, and the helper lists every Mac app here", () => {
    const helper = helperTerminals().map(asGateway);
    expect(helper.length).toBeGreaterThan(10);
    const mac = TERMINAL_IDE_APPS.filter((id) => !id.endsWith(".exe")).map((id) =>
      id.toLowerCase(),
    );
    expect([...mac].sort()).toEqual([...helper].sort());
  });

  it.each([
    "app.crynta.terax",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
    "com.vscodium",
    "com.exafunction.windsurf",
    "com.google.android.studio",
    "com.panic.Nova",
    "com.barebones.bbedit",
    "com.apple.ScriptEditor2",
    "com.apple.Automator",
    "com.sublimetext.3",
    "org.alacritty",
  ])("caps %s at click", (id) => {
    expect(appCap(id).cap).toBe("click");
  });

  it.each(["com.apple.Notes", "com.apple.TextEdit", "app.crynta.teraxnotes", "com.vscodiumx"])(
    "leaves %s alone",
    (id) => {
      expect(appCap(id).cap).toBe("interact");
    },
  );
});
