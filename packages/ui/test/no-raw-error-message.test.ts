import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A UI file must not show `err.message` as is: the Gateway writes it in English. What the owner
 * sees goes through `describeError` (or `describeStepError` for a run step's plain `{ code,
 * message }`), which picks the catalogue sentence in any other language.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIRS = [
  "packages/ui/src",
  "apps/desktop/src/shell",
  "apps/desktop/src/compose",
  "apps/desktop/src/client",
  "apps/desktop/src/lib",
];

/** Reading the message to decide something (a regex test, a truthiness check) is not showing it. */
const ALLOWED_LINE = [
  /\.test\(\s*\w+(?: instanceof Error \? \w+\.message : String\(\w+\))?/,
  /&&\s*(?:err|error|e)\.message\b/,
  /\bdescribeError\(/,
  // Comparing or parsing the stored message, not showing it.
  /!==\s*step\.error\?\.message/,
  /parseNotVerified\(/,
  /isUnavailableMessage\(/,
];
/** Files that implement or wrap the central mapping. */
const ALLOWED_FILE = ["packages/ui/src/i18n/errors.ts", "packages/ui/src/blocks/answer-error.ts"];

const RAW = /\b(?:err|error|e|cause)\??\.message\b/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === "test") continue;
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx$/.test(name) && !/\.(test|stories)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

export function rawMessageLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => RAW.test(line) && !ALLOWED_LINE.some((re) => re.test(line)));
}

describe("UI errors go through describeError", () => {
  it("no UI file shows err.message outside describeError", () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (ALLOWED_FILE.includes(rel)) continue;
        for (const line of rawMessageLines(readFileSync(file, "utf8"))) {
          hits.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("the scan flags a raw message and lets the allowed shapes through (positive control)", () => {
    expect(
      rawMessageLines("setError(err instanceof Error ? err.message : String(err));"),
    ).toHaveLength(1);
    expect(rawMessageLines("const r = String(error.message);")).toHaveLength(1);
    expect(rawMessageLines("setError(describeError(err));")).toHaveLength(0);
    expect(rawMessageLines("if (/conflict/i.test(err.message)) return;")).toHaveLength(0);
    expect(rawMessageLines("return error instanceof Error && error.message ? 1 : 2;")).toHaveLength(
      0,
    );
  });
});
