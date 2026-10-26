import { describe, expect, it } from "vitest";
import { matchApproval, normalizeUtterance, voicePhrases } from "../src/voice/phrases.ts";

/** The spoken phrase lists (voice-mode-2026 §4.3, §4.6), from the active (English) catalogue. */
describe("voice phrases", () => {
  it("reads the lists from the catalogue", () => {
    expect(voicePhrases("approve")).toContain("send it");
    expect(voicePhrases("deny")).toContain("cancel");
    expect(voicePhrases("trailing")).toContain("um");
  });

  it("matches whole utterances only, after normalisation", () => {
    expect(normalizeUtterance("  Send it! ")).toBe("send it");
    expect(matchApproval("Send it.")).toBe("approve");
    expect(matchApproval("Don’t")).toBe("deny");
    expect(matchApproval("don't")).toBe("deny");
    // Anything else leaves the card on screen.
    expect(matchApproval("send it to bob instead")).toBeNull();
    expect(matchApproval("")).toBeNull();
  });
});
