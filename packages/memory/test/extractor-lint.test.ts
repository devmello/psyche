import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT } from "../src/extraction/index.ts";

const DIR = join(import.meta.dirname, "..", "src", "extraction");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const src = (f: string) => readFileSync(join(DIR, f), "utf8");

/**
 * The lint rule for the extractor call site (docs/design/everything-memory-2026.md §5.7): item
 * text reaches a model in exactly one place, and that place offers no tools. A source scan, so a
 * later edit that adds a tool, a second call site or a settings/agent import fails CI.
 */
describe("extractor call site", () => {
  it("only extractor.ts streams from a model", () => {
    const callers = files.filter((f) => /\.stream\(/.test(src(f)));
    expect(callers).toEqual(["extractor.ts"]);
  });

  it("offers no tools: tools is [] and toolChoice is none, and no other value appears anywhere", () => {
    const text = src("extractor.ts");
    expect(text.match(/\btools\s*:/g)).toHaveLength(1);
    expect(text).toMatch(/\btools:\s*\[\]/);
    expect(text).toMatch(/toolChoice:\s*"none"/);
    expect(text).toMatch(/temperature:\s*0\b/);
    for (const f of files) {
      if (f === "extractor.ts") continue;
      expect(src(f), f).not.toMatch(/\btools\s*:/);
      expect(src(f), f).not.toMatch(/toolChoice/);
    }
  });

  it("the extraction code imports no agent, settings, vault, network or file-write surface", () => {
    for (const f of files) {
      const imports = [...src(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(
          /agent-core|vault|permissions|connectors|browser|sandbox|gateway|node:(?:fs|net|http|https|child_process|dgram|dns)/,
        );
      }
    }
  });

  it("the system prompt is pinned (change it and bump EXTRACT_PROMPT_VERSION)", () => {
    const golden = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "tests",
        "fixtures",
        "everything-memory",
        "extract-prompt.v1.txt",
      ),
      "utf8",
    );
    expect(EXTRACT_PROMPT_VERSION).toBe(1);
    expect(EXTRACT_SYSTEM_PROMPT).toBe(golden.replace(/\n$/, ""));
    // It never carries settings, ids or the owner's data.
    expect(EXTRACT_SYSTEM_PROMPT).not.toMatch(/memory\.everything|entityId|@/);
  });
});
