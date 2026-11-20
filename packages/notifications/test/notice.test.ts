import { describe, expect, it } from "vitest";
import { cleanNoticeMessage, cleanNoticeValue } from "../src/index.ts";
import { setup, sqliteStore } from "./helpers.ts";

const message = {
  titleKey: "notice.apiKey.changed.title",
  bodyKey: "notice.apiKey.changed.body",
  params: { provider: "Anthropic", device: "Phone" },
};

describe("keyed notices", () => {
  it("keeps the English text and adds the message (an old client reads only the text)", async () => {
    const { notifier } = setup();
    const n = await notifier.notify({ kind: "system", title: "English", body: "Body", message });
    expect(n.title).toBe("English");
    expect(n.body).toBe("Body");
    expect(n.message).toEqual(message);
    const plain = await notifier.notify({ kind: "system", title: "A", body: "B" });
    expect(plain.message).toBeUndefined();
  });

  it("survives the SQLite store, and a de-duplicated update replaces it with its text", async () => {
    const { store } = sqliteStore();
    const { notifier } = setup({ store });
    const first = await notifier.notify({
      kind: "system",
      title: "T",
      body: "B",
      message,
      dedupeKey: "k",
    });
    expect((await notifier.get(first.id))?.message).toEqual(message);
    await notifier.notify({ kind: "system", title: "T2", body: "B2", dedupeKey: "k" });
    const after = await notifier.get(first.id);
    expect(after?.title).toBe("T2");
    expect(after?.message).toBeUndefined();
  });

  it("drops a message whose ids are malformed, keeping the notification", async () => {
    const { notifier } = setup();
    const n = await notifier.notify({
      kind: "system",
      title: "T",
      body: "B",
      message: { titleKey: "<script>", bodyKey: "notice.x.y" },
    });
    expect(n.message).toBeUndefined();
    expect(n.title).toBe("T");
  });
});

describe("notice values are sanitised", () => {
  const evil = "Own‮er⁦s​ iPhone\u0007\n\u0000x";
  it.each([
    ["bidi override", "a‮b", "a b"],
    ["isolates", "a⁦b⁩c", "a b c"],
    ["zero width", "a​b﻿c", "a b c"],
    ["tag characters", `a${String.fromCodePoint(0xe0041)}b`, "a b"],
    ["controls and newlines", "a\u0000b\nc\td", "a b c d"],
    ["separators", "a b c", "a b c"],
  ])("%s", (_name, raw, clean) => {
    expect(cleanNoticeValue(raw)).toBe(clean);
  });

  it("cleans every string param, drops odd names and values, bounds the length", () => {
    const out = cleanNoticeMessage({
      titleKey: "notice.a.title",
      bodyKey: "notice.a.body",
      params: {
        device: evil,
        "bad name": "x",
        n: 3,
        inf: Number.POSITIVE_INFINITY,
        long: "x".repeat(5000),
      },
    });
    expect(out?.params?.device).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(out?.params).not.toHaveProperty("bad name");
    expect(out?.params).not.toHaveProperty("inf");
    expect(out?.params?.n).toBe(3);
    expect([...String(out?.params?.long)].length).toBeLessThanOrEqual(2048);
  });

  it("is applied by the notifier, whoever the caller is", async () => {
    const { notifier } = setup();
    const n = await notifier.notify({
      kind: "system",
      title: "T",
      body: "B",
      message: { ...message, params: { provider: "P", device: evil } },
    });
    expect(n.message?.params?.device).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});
