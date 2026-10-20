import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb, setSetting } from "@psyche/db";
import type { PolicyConfig } from "@psyche/permissions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appTiersFrom,
  COMPUTER_USE_APPS,
  COMPUTER_USE_ENABLED,
  computerUseFile,
  computerUsePath,
  computerUseSettings,
} from "../src/compose/computer-settings.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { needsPresence } from "../src/handlers/settings.ts";

let home = "";
let db: PsycheDb;
let policy: PolicyConfig;
const published: { event: string; payload: unknown }[] = [];

beforeEach(() => {
  published.length = 0;
  home = mkdtempSync(join(tmpdir(), "psyche-cu-"));
  db = openDb(join(home, "psyche.db"));
  policy = { defaultMode: "balanced", apps: { "com.apple.finder": "read" } };
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function services(): ComposeServices {
  const rawBroker = {
    get policy() {
      return policy;
    },
    setPolicy(c: PolicyConfig) {
      policy = c;
    },
  };
  return {
    db,
    home,
    rawBroker,
    publish: (event: string, payload: unknown) => published.push({ event, payload }),
  } as unknown as ComposeServices;
}

const readFile = () => JSON.parse(readFileSync(computerUsePath(home), "utf8"));

describe("Settings → Computer use → computer-use.json and broker tiers (J5, F6)", () => {
  it("keeps only valid bundle ids and tiers", () => {
    expect(
      appTiersFrom([
        { id: "com.apple.Notes", name: "Notes", tier: "interact" },
        { id: "banking", name: "Banking", tier: "off" },
        { id: "com.apple.Mail", tier: "ask" },
        { id: "com.apple.Maps", tier: "read" },
        null,
      ]),
    ).toEqual({ "com.apple.Notes": "interact", "com.apple.Maps": "read" });
    expect(computerUseFile(undefined, [{ id: "com.apple.Notes", tier: "interact" }])).toEqual({
      version: 1,
      default: "off",
      apps: {},
    });
  });

  it("writes the helper's file (0600) and layers the tiers over permissions.policy", () => {
    const s = computerUseSettings(services());
    s.sync();
    expect(readFile()).toEqual({ version: 1, default: "off", apps: {} });
    expect(statSync(computerUsePath(home)).mode & 0o777).toBe(0o600);
    expect(policy.apps).toEqual({ "com.apple.finder": "read" });

    const entries = [
      setSetting(db, COMPUTER_USE_ENABLED, true),
      setSetting(db, COMPUTER_USE_APPS, [
        { id: "com.apple.Notes", name: "Notes", tier: "interact" },
      ]),
    ];
    s.onChanged(entries);
    expect(readFile()).toEqual({
      version: 1,
      default: "ask",
      apps: { "com.apple.Notes": "interact" },
    });
    expect(policy.apps).toEqual({ "com.apple.finder": "read", "com.apple.Notes": "interact" });

    // A new permissions.policy (applied first by the composition root) keeps the layer on top.
    const next: PolicyConfig = { defaultMode: "manual", apps: { "com.apple.Notes": "read" } };
    policy = next;
    s.onChanged([{ key: "permissions.policy", value: next }]);
    expect(policy).toEqual({ defaultMode: "manual", apps: { "com.apple.Notes": "interact" } });

    s.onChanged([setSetting(db, COMPUTER_USE_ENABLED, false)]);
    expect(readFile().default).toBe("off");
    expect(policy.apps).toEqual({ "com.apple.Notes": "read" });
  });

  it("lists an app as Ask the first time the agent uses it, once", () => {
    const s = computerUseSettings(services());
    setSetting(db, COMPUTER_USE_APPS, [{ id: "com.apple.Notes", name: "Notes", tier: "read" }]);
    s.noteApp("com.apple.notes");
    s.noteApp("com.apple.reminders", "Reminders");
    s.noteApp("com.apple.reminders");
    s.noteApp("not a bundle id");
    expect(published).toHaveLength(1);
    expect(published[0]?.event).toBe("settings.changed");
    const rows = (published[0]?.payload as { entries: { value: unknown }[] } | undefined)
      ?.entries[0]?.value;
    expect(rows).toEqual([
      { id: "com.apple.Notes", name: "Notes", tier: "read" },
      { id: "com.apple.reminders", name: "Reminders", tier: "ask" },
    ]);
    // Ask rows widen nothing: the helper's file keeps them at its default.
    expect(appTiersFrom(rows)).toEqual({ "com.apple.Notes": "read" });
  });

  it("treats computer-use settings as security settings", () => {
    expect(needsPresence(COMPUTER_USE_ENABLED)).toBe(true);
    expect(needsPresence(COMPUTER_USE_APPS)).toBe(true);
  });
});
