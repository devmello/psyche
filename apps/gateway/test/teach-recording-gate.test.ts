import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { assertDesktopRecording } from "../src/compose/skills.ts";

/** Teach by showing: only the Psyche desktop shell on the Host saves a recording. */
describe("assertDesktopRecording", () => {
  it("lets the desktop shell through", () => {
    expect(() => assertDesktopRecording({ desktopShell: true })).not.toThrow();
  });
  it("refuses any other device, however it is scoped", () => {
    for (const identity of [{}, { desktopShell: undefined }]) {
      try {
        assertDesktopRecording(identity);
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(PsycheError);
        expect((e as PsycheError).code).toBe("forbidden");
        expect((e as PsycheError).message).toContain("on this Mac");
      }
    }
  });
});
