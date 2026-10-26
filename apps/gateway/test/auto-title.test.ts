import { appendMessage, createThread, getThread, openDb, setSetting } from "@psyche/db";
import type { ModelEvent, ModelProvider, Run, Thread } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  AUTO_TITLE_SETTING,
  autoTitleMode,
  cleanModelTitle,
  createAutoTitler,
  heuristicTitle,
} from "../src/compose/auto-title.ts";

describe("heuristicTitle", () => {
  it("keeps a short first message", () => {
    expect(heuristicTitle("plan my trip to Lisbon")).toBe("Plan my trip to Lisbon");
  });
  it("cuts a long message at a word boundary", () => {
    const t = heuristicTitle(
      "Could you please help me figure out why my sourdough starter never doubles overnight",
    );
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(49);
    expect(t).not.toMatch(/\s…$/);
  });
  it("drops links, code and markdown", () => {
    expect(heuristicTitle("**Summarize** https://example.com/a/very/long/path please")).toBe(
      "Summarize please",
    );
    expect(heuristicTitle("```ts\nconst x = 1\n```")).toBe("");
  });
});

describe("cleanModelTitle", () => {
  it("strips quotes, prefixes and trailing punctuation", () => {
    expect(cleanModelTitle('Title: "Lisbon trip planning."\nextra')).toBe("Lisbon trip planning");
  });
  it("rejects empty or rambling answers", () => {
    expect(cleanModelTitle("  \n")).toBeUndefined();
    expect(cleanModelTitle("x".repeat(80))).toBeUndefined();
  });
});

function setup(opts: { reply?: string; fail?: boolean; hang?: boolean } = {}) {
  const db = openDb(":memory:");
  const published: Thread[] = [];
  let calls = 0;
  const provider: ModelProvider = {
    id: "fake",
    capabilities: async () => ({}) as never,
    async *stream(req, o): AsyncIterable<ModelEvent> {
      calls += 1;
      expect(req.maxOutputTokens).toBe(24);
      if (opts.fail) throw new Error("down");
      if (opts.hang) {
        await new Promise((_, rej) =>
          o?.signal?.addEventListener("abort", () => rej(new Error("x"))),
        );
      }
      yield { type: "text_delta", text: opts.reply ?? "Lisbon trip planning" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const titler = createAutoTitler({
    db,
    provider,
    model: "fake/utility",
    redactor: { redact: (s: string) => s.replace("sk-secret", "redacted") },
    publish: (_e, p) => published.push(p.thread),
    timeoutMs: 50,
  });
  const chat = (kind: "side" | "main" = "side") => {
    const id = db.newId();
    createThread(db, { id, kind, sessionKey: `k:${id}` });
    for (const [role, text] of [
      ["user", "plan my trip to Lisbon sk-secret"],
      ["agent", "Sure, when are you going?"],
    ] as const) {
      appendMessage(
        db,
        {
          threadId: id,
          role,
          blocks: [{ type: "text", md: text }],
          provenance: role === "user" ? "owner" : "agent",
          runId: null,
        } as never,
        { expectedWriterRunId: null },
      );
    }
    return id;
  };
  const done = (threadId: string) =>
    ({ threadId, status: "done" }) as Pick<Run, "threadId" | "status">;
  return { db, titler, chat, done, published, calls: () => calls };
}

describe("auto titler", () => {
  it("names a new chat with the model, heuristic first", async () => {
    const s = setup();
    const id = s.chat();
    await s.titler.onRunFinished(s.done(id));
    expect(s.published.map((t) => t.title)).toEqual([
      "Plan my trip to Lisbon redacted",
      "Lisbon trip planning",
    ]);
    expect(getThread(s.db, id)?.titleSource).toBe("auto");
  });

  it("keeps the first-message title when the model fails or times out", async () => {
    for (const o of [{ fail: true }, { hang: true }]) {
      const s = setup(o);
      const id = s.chat();
      await s.titler.onRunFinished(s.done(id));
      expect(getThread(s.db, id)?.title).toBe("Plan my trip to Lisbon redacted");
    }
  });

  it("never touches a user title, the main thread, or a titled chat", async () => {
    const s = setup();
    const id = s.chat();
    s.db.sqlite.prepare("update threads set title='Mine', title_source='user' where id=?").run(id);
    await s.titler.onRunFinished(s.done(id));
    expect(getThread(s.db, id)?.title).toBe("Mine");
    const main = s.chat("main");
    await s.titler.onRunFinished(s.done(main));
    expect(getThread(s.db, main)?.title).toBe("");
    expect(s.calls()).toBe(0);
  });

  it("only runs for a finished run", async () => {
    const s = setup();
    const id = s.chat();
    await s.titler.onRunFinished({ threadId: id, status: "failed" });
    expect(getThread(s.db, id)?.title).toBe("");
  });

  it("honours the off and heuristic modes", async () => {
    const off = setup();
    setSetting(off.db, AUTO_TITLE_SETTING, "off");
    const a = off.chat();
    await off.titler.onRunFinished(off.done(a));
    expect(getThread(off.db, a)?.title).toBe("");
    expect(autoTitleMode(off.db)).toBe("off");

    const quick = setup();
    setSetting(quick.db, AUTO_TITLE_SETTING, "heuristic");
    const b = quick.chat();
    await quick.titler.onRunFinished(quick.done(b));
    expect(getThread(quick.db, b)?.title).toBe("Plan my trip to Lisbon redacted");
    expect(quick.calls()).toBe(0);

    setSetting(quick.db, AUTO_TITLE_SETTING, false);
    expect(autoTitleMode(quick.db)).toBe("off");
  });
});
