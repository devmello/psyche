import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { VM_SETTING_KEYS } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { SETTING_LABELS, settingLabel } from "../src/screens/settings/setting-labels.ts";

/** Every setting key the kit (and the composed app) reads or writes, found in the source. */
function keysInSource(): Set<string> {
  const roots = [
    // Vitest runs from packages/ui.
    join(process.cwd(), "src/screens"),
    join(process.cwd(), "src/agent"),
    join(process.cwd(), "../../apps/web/src/compose"),
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.(stories|test)\.tsx?$/.test(name)) files.push(path);
    }
  };
  for (const r of roots) walk(r);
  const key = String.raw`"([a-z][A-Za-z]*\.[A-Za-z][A-Za-z0-9.]*)"`;
  const patterns = [
    new RegExp(String.raw`settingKey=${key}`, "g"),
    new RegExp(String.raw`(?:onChange|str|bool|num|set)\((?:values, )?${key}`, "g"),
    new RegExp(String.raw`[A-Z_]*KEY = ${key}`, "g"),
  ];
  const found = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const p of patterns) for (const m of text.matchAll(p)) found.add(m[1] as string);
  }
  for (const k of Object.values(VM_SETTING_KEYS)) found.add(k);
  return found;
}

describe("setting labels (docs/ui-audit.md decision 1)", () => {
  it("has a label for every key the kit and the app read or write", () => {
    const keys = keysInSource();
    expect(keys.size).toBeGreaterThan(20);
    const missing = [...keys].filter((k) => settingLabel(k) === "this setting");
    expect(missing).toEqual([]);
  });

  it("never returns a raw key", () => {
    for (const label of Object.values(SETTING_LABELS))
      expect(label).not.toMatch(/^[a-z]+\.[a-zA-Z.]+$/);
    expect(settingLabel("permissions.connectors.conn_gmail")).toBe("Access for gmail");
    expect(settingLabel("something.unknown")).toBe("this setting");
  });
});
