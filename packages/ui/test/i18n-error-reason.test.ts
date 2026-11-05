import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayRequestError } from "../src/data/client.ts";
import {
  activeI18n,
  createI18n,
  describeError,
  errorSummary,
  setActiveI18n,
} from "../src/i18n/index.ts";

/** A Gateway `details.reason` with a sentence in the catalogue beats the generic one for its code. */

const initial = activeI18n();
afterEach(() => setActiveI18n(initial));

const updating = () =>
  new GatewayRequestError("chat.send", "unavailable", "Psyche is about to restart to update", {
    reason: "updating",
  });

describe("error reasons", () => {
  it("says the update is coming, not just 'can't do that right now'", () => {
    setActiveI18n({ ...createI18n({ locale: "en-US" }), messageLocale: "xx" });
    expect(describeError(updating())).toBe(
      "Psyche is about to restart to install an update. Try again in a moment.",
    );
    expect(errorSummary(updating())).toBe(
      "Psyche is about to restart to install an update. Try again in a moment.",
    );
  });

  it("falls back to the code's sentence for a reason the catalogue does not know, or none", () => {
    setActiveI18n({ ...createI18n({ locale: "en-US" }), messageLocale: "xx" });
    const other = new GatewayRequestError("chat.send", "unavailable", "x", { reason: "other" });
    expect(describeError(other)).toBe("Psyche can't do that right now.");
    expect(describeError(new PsycheError("unavailable", "x"))).toBe(
      "Psyche can't do that right now.",
    );
    expect(describeError(new PsycheError("unavailable", "x", { details: "text" }))).toBe(
      "Psyche can't do that right now.",
    );
  });

  it("keeps the Gateway's own English message in English", () => {
    setActiveI18n(createI18n({ locale: "en-US" }));
    expect(describeError(updating())).toBe("Psyche is about to restart to update");
  });

  it("is translated, with no English fallback", () => {
    setActiveI18n({ ...createI18n({ locale: "de-DE" }), messageLocale: "de" });
    expect(describeError(updating())).toBe(
      "Psyche startet gleich neu, um ein Update zu installieren. Versuche es in einem Moment erneut.",
    );
  });
});
