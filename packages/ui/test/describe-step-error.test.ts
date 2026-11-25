import { afterEach, describe, expect, it } from "vitest";
import { activeI18n, createI18n, describeStepError, setActiveI18n } from "../src/i18n/index.ts";

/** A run step's stored error is `{ code, message }`: never shown as a raw code outside English. */

const initial = activeI18n();
afterEach(() => setActiveI18n(initial));

describe("describeStepError", () => {
  it("shows the step's own message in English, without the code", () => {
    setActiveI18n(createI18n({ locale: "en-US" }));
    const text = describeStepError({ code: "forbidden", message: "Blocked by a rule" });
    expect(text).toBe("Blocked by a rule");
  });

  it("uses the code's sentence outside English, never the raw code or message", () => {
    setActiveI18n({ ...createI18n({ locale: "en-US" }), messageLocale: "xx" });
    const text = describeStepError({ code: "presence_agent_missing", message: "polkit: no agent" });
    expect(text).toContain("password prompt");
    expect(text).not.toContain("presence_agent_missing");
    expect(text).not.toContain("polkit");
  });

  it("says something went wrong for a code the catalogue does not know", () => {
    setActiveI18n({ ...createI18n({ locale: "en-US" }), messageLocale: "xx" });
    expect(describeStepError({ code: "made_up_code", message: "x" })).toBe("Something went wrong.");
  });

  it("has a sentence for each of the four presence codes", () => {
    setActiveI18n({ ...createI18n({ locale: "en-US" }), messageLocale: "xx" });
    for (const code of [
      "presence_unavailable_here",
      "presence_agent_missing",
      "presence_policy_missing",
      "presence_not_enforced",
    ]) {
      expect(describeStepError({ code, message: "" }), code).not.toBe("Something went wrong.");
    }
  });
});
