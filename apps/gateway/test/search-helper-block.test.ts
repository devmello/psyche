import type { ConnectorRecord } from "@psyche/connectors";
import { appleAdapters } from "@psyche/search";
import { describe, expect, it } from "vitest";
import { appleSearchSeams } from "../src/compose/search-apple.ts";

const mailRecord = {
  id: "apple-mail",
  type: "apple:mail",
  status: "connected",
} as unknown as ConnectorRecord;

describe("Apple reads while the paired helper cannot serve them", () => {
  it("makes one attempt, then no connector call until the helper connects again", async () => {
    let attempts = 0;
    const tools = {
      get: () => ({
        execute: async () => {
          attempts += 1;
          throw new Error("Apple Mail needs the Psyche helper on your Mac: allow it to pair");
        },
      }),
    } as never;
    const s = appleSearchSeams({
      connectors: async () => [mailRecord],
      tools,
      messages: () => undefined,
      helperOnline: () => true,
      now: () => 0,
    });
    await s.refresh();
    const mail = appleAdapters(s.deps).find((a) => a.id === "mail");
    const signal = new AbortController().signal;
    await expect(s.deps.call("mail")?.("mail_search_messages", {}, signal)).rejects.toThrow(
      /needs the Psyche helper/,
    );
    expect(attempts).toBe(1);

    // Blocked: the source says the helper is missing and no connector call is made.
    expect(s.deps.call("mail")).toBeUndefined();
    expect(mail?.unavailable()).toBe("the Mac helper is not connected");
    expect(attempts).toBe(1);

    // The helper connects again: reads are attempted again.
    s.deps.resumeHelper?.();
    expect(s.deps.call("mail")).toBeTypeOf("function");
  });

  it("makes no connector call at all while the helper is offline", async () => {
    let attempts = 0;
    const tools = {
      get: () => ({
        execute: async () => {
          attempts += 1;
          return { output: {} };
        },
      }),
    } as never;
    const s = appleSearchSeams({
      connectors: async () => [mailRecord],
      tools,
      messages: () => undefined,
      helperOnline: () => false,
      now: () => 0,
    });
    await s.refresh();
    expect(s.deps.call("mail")).toBeUndefined();
    expect(attempts).toBe(0);
  });
});
