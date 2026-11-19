import { describe, expect, it } from "vitest";
import { needsPresence } from "../src/handlers/settings.ts";
import { isSealedSettingKey, isSecuritySettingKey } from "../src/security/seal-spec.ts";

/**
 * The optional sensitive categories (government, iCloud) are the owner's Settings toggles: one
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
