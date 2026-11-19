import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb, setSetting } from "@psyche/db";
import type { PolicyConfig } from "@psyche/permissions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySensitiveCategories } from "../src/compose/sensitive-categories.ts";
import { needsPresence } from "../src/handlers/settings.ts";
import { isSealedSettingKey, isSecuritySettingKey } from "../src/security/seal-spec.ts";

/**
 * The optional sensitive categories (government, iCloud) are the owner's Settings switches: one
 * tap with no presence step, still sealed so an out-of-band write is undone.
 */
const TOGGLES = ["permissions.sensitive.government", "permissions.sensitive.icloud"];

describe("permissions.sensitive.* settings", () => {
  it.each(TOGGLES)("%s needs no presence but is a sealed security setting", (key) => {
    expect(needsPresence(key)).toBe(false);
    expect(isSecuritySettingKey(key)).toBe(true);
    expect(isSealedSettingKey(key)).toBe(true);
  });

  it("control: the policy itself still needs presence, an unrelated key is not sealed", () => {
    expect(needsPresence("permissions.policy")).toBe(true);
    expect(needsPresence("permissions.sensitive.other")).toBe(true);
    expect(isSecuritySettingKey("appearance.theme")).toBe(false);
  });
});

describe("flipping a switch keeps the broker's other policy layers", () => {
  let home = "";
  let db: PsycheDb;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psyche-sens-"));
    db = openDb(join(home, "psyche.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  // Layered onto the live policy by the connector matrix and Computer use parts, not stored.
  const live = (): PolicyConfig => ({
    defaultMode: "balanced",
    connectors: { notion: { mcp__notion__search: "deny" } },
    liftedFloors: { gmail: ["gmail.send"] },
    apps: { "com.example.bank": "off" },
  });

  it.each(["government", "icloud"] as const)(
    "toggling %s leaves connectors, lifted floors and app tiers",
    (cat) => {
      let policy = live();
      const broker = {
        get policy() {
          return policy;
        },
        setPolicy(c: PolicyConfig) {
          policy = c;
        },
      };
      setSetting(db, `permissions.sensitive.${cat}`, false);
      applySensitiveCategories(broker, db);
      expect(policy.connectors).toEqual(live().connectors);
      expect(policy.liftedFloors).toEqual(live().liftedFloors);
      expect(policy.apps).toEqual(live().apps);
      // Positive control: the switch took effect, for its own category only.
      const other = cat === "government" ? "icloud" : "government";
      expect(policy.sensitiveCategories?.[cat]).toBe(false);
      expect(policy.sensitiveCategories?.[other]).toBe(true);
    },
  );
});
