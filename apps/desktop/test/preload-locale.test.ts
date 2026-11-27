import { isLocaleLoaded } from "@psyche/ui";
import { describe, expect, it } from "vitest";
import { loadFirstLocale } from "../src/renderer/preload-locale.ts";

describe("the language a window loads before its first render (D1)", () => {
  it("loads the system language's catalogue and no other", async () => {
    expect(isLocaleLoaded("ko")).toBe(false);
    await loadFirstLocale(async () => "ko-KR");
    expect(isLocaleLoaded("ko")).toBe(true);
    expect(isLocaleLoaded("ja")).toBe(false);
  });

  it("never throws when main does not answer", async () => {
    await expect(
      loadFirstLocale(async () => {
        throw new Error("no ipc");
      }),
    ).resolves.toBeUndefined();
  });
});
