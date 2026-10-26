import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("main app stays a regular app (Dock + ⌘Tab)", () => {
  const files = sources(SRC).map((p) => ({ p, text: readFileSync(p, "utf8") }));

  it("never switches the activation policy or hides the Dock icon", () => {
    for (const { p, text } of files) {
      expect(text, p).not.toMatch(/setActivationPolicy|dock\??\.hide\(/);
    }
  });

  // On macOS, setVisibleOnAllWorkspaces with visibleOnFullScreen transforms the
  // process into a UIElement (agent) app, dropping it from the Dock and ⌘Tab,
  // unless skipTransformProcessType is set.
  it("floating panels skip Electron's process-type transform", () => {
    for (const { p, text } of files) {
      for (const m of text.matchAll(/setVisibleOnAllWorkspaces\(([^)]*)\)/g)) {
        if (m[1]?.includes("visibleOnFullScreen")) {
          expect(m[1], p).toContain("skipTransformProcessType: true");
        }
      }
    }
  });
});
