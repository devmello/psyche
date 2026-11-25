import { createThread, openDb } from "@psyche/db";
import { describe, expect, it } from "vitest";
import { channelCapabilityProvider } from "../src/compose/channels.ts";

const input = (threadId: string) => ({
  threadId,
  runId: "run_1",
  text: "send me the file",
  mode: "chat" as never,
  permissionMode: "balanced" as never,
});

function setup() {
  let n = 0;
  const db = openDb(":memory:", {
    now: () => new Date(1_700_000_000_000).toISOString(),
    newId: () => `id${++n}`,
  });
  return { db, provider: channelCapabilityProvider(db) };
}

describe("channel capability turn context", () => {
  it.each(["imessage", "signal", "whatsapp", "sms"])(
    "tells the agent on %s that files are not sent (trusted, system-authored)",
    async (type) => {
      const { db, provider } = setup();
      createThread(db, {
        id: "thr_c",
        kind: "channel",
        sessionKey: `channel:${type}:acct:dm:peer`,
      });
      const ctx = await provider.provide(input("thr_c"));
      expect(ctx?.trusted).toBe(true);
      expect(ctx?.sections[0]?.text).toContain("do not offer to attach");
    },
  );

  it.each(["telegram", "slack", "discord", "email"])("adds nothing on %s", async (type) => {
    const { db, provider } = setup();
    createThread(db, { id: "thr_c", kind: "channel", sessionKey: `channel:${type}:acct:dm:peer` });
    expect(await provider.provide(input("thr_c"))).toBeUndefined();
  });

  it("adds nothing outside channel threads", async () => {
    const { db, provider } = setup();
    createThread(db, { id: "thr_m", kind: "main", sessionKey: "main" });
    expect(await provider.provide(input("thr_m"))).toBeUndefined();
  });
});
