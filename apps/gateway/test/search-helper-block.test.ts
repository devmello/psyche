import type { ConnectorRecord } from "@psyche/connectors";
import { appleAdapters } from "@psyche/search";
import { describe, expect, it } from "vitest";
import { appleSearchSeams, HELPER_RETRY_MS } from "../src/compose/search-apple.ts";

const mailRecord = {
  id: "apple-mail",
  type: "apple:mail",
  status: "connected",
} as unknown as ConnectorRecord;

const REFUSAL = "Apple Mail needs the Psyche helper on your Mac: allow it to pair";

/** Mail seams whose connector refuses with `refusal` (or answers when it is undefined). */
function mailSeams(opts: {
  clock: { t: number };
  refusing: { on: boolean };
  attempts: { n: number };
}) {
  const tools = {
    get: () => ({
      execute: async () => {
        opts.attempts.n += 1;
        if (opts.refusing.on) throw new Error(REFUSAL);
        return { output: { messages: [] } };
      },
    }),
  } as never;
  return appleSearchSeams({
    connectors: async () => [mailRecord],
    tools,
    messages: () => undefined,
    helperOnline: () => true,
    now: () => opts.clock.t,
  });
}

describe("Apple reads while the paired helper cannot serve them", () => {
  it("makes one attempt, then no connector call until resumed or the retry interval passes", async () => {
    const clock = { t: 0 };
    const refusing = { on: true };
    const attempts = { n: 0 };
    const s = mailSeams({ clock, refusing, attempts });
    await s.refresh();
    const mail = appleAdapters(s.deps).find((a) => a.id === "mail");
    const signal = new AbortController().signal;
    await expect(s.deps.call("mail")?.("mail_search_messages", {}, signal)).rejects.toThrow(
      /needs the Psyche helper/,
    );
    expect(attempts.n).toBe(1);

    // Blocked: the source says the helper is missing and no connector call is made.
    expect(s.deps.call("mail")).toBeUndefined();
    expect(mail?.unavailable()).toBe("the Mac helper is not connected");
    expect(attempts.n).toBe(1);
  });

  it("resumes at once when resumeHelper is called (a connect or an approved pairing)", async () => {
    const clock = { t: 0 };
    const refusing = { on: true };
    const attempts = { n: 0 };
    const s = mailSeams({ clock, refusing, attempts });
    await s.refresh();
    const signal = new AbortController().signal;
    await expect(s.deps.call("mail")?.("mail_search_messages", {}, signal)).rejects.toThrow();
    expect(s.deps.call("mail")).toBeUndefined();

    refusing.on = false;
    s.deps.resumeHelper?.();
    expect(s.deps.call("mail")).toBeTypeOf("function");
    await s.deps.call("mail")?.("mail_search_messages", {}, signal);
    expect(attempts.n).toBe(2);
  });

  it("retries one read every 30 minutes while blocked, and stays blocked if it is refused again", async () => {
    const clock = { t: 0 };
    const refusing = { on: true };
    const attempts = { n: 0 };
    const s = mailSeams({ clock, refusing, attempts });
    await s.refresh();
    const signal = new AbortController().signal;
    await expect(s.deps.call("mail")?.("mail_search_messages", {}, signal)).rejects.toThrow();

    clock.t = HELPER_RETRY_MS - 1;
    expect(s.deps.call("mail")).toBeUndefined();

    clock.t = HELPER_RETRY_MS;
    expect(s.deps.call("mail")).toBeTypeOf("function");
    await expect(s.deps.call("mail")?.("mail_search_messages", {}, signal)).rejects.toThrow();
    expect(attempts.n).toBe(2);

    // The retry was refused, so the next interval starts from that refusal.
    clock.t = HELPER_RETRY_MS + HELPER_RETRY_MS - 1;
    expect(s.deps.call("mail")).toBeUndefined();
  });

  it("clears the block for good once a retry succeeds", async () => {
    const clock = { t: 0 };
    const refusing = { on: true };
    const attempts = { n: 0 };
    const s = mailSeams({ clock, refusing, attempts });
    await s.refresh();
    const signal = new AbortController().signal;
    await expect(s.deps.call("mail")?.("mail_search_messages", {}, signal)).rejects.toThrow();

    refusing.on = false;
    clock.t = HELPER_RETRY_MS;
    await s.deps.call("mail")?.("mail_search_messages", {}, signal);
    clock.t = HELPER_RETRY_MS + 1;
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
