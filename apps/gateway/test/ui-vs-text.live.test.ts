/**
 * Live gate for the render_ui guidance (docs/design/generative-ui-2026.md §6.4, P3): a real model
 * (Haiku 5.5 only) sees the real widget tool specs and the real `UI_GUIDANCE` system text, then
 * answers each prompt of `packages/agent-core/test/fixtures/ui-vs-text-cases.json`. A `render_ui`
 * call counts as "ui", `update_ui` as "update_ui" (a `list_ui` lookup is answered "no widgets" and the
 * model goes on for up to three steps; a lookup alone also counts as "update_ui"), no widget call as "text". Skipped unless
 * `PSYCHE_LIVE_TESTS=1`; the key is `ANTHROPIC_API_KEY` or the nearest `.env`, never printed.
 *
 *   PSYCHE_LIVE_TESTS=1 pnpm --filter @psyche/gateway exec vitest run test/ui-vs-text.live.test.ts --maxWorkers=1
 *
 * Spends about 11 short calls. It reports the pass rate; it only fails on the hard rule (a widget
 * must never be drawn for the approval request).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_GUIDANCE } from "@psyche/agent-core";
import type { ModelEvent, ModelMessage } from "@psyche/protocol";
import { createLiveHaikuProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type { WidgetStore } from "../src/widgets/store.ts";
import { widgetTools } from "../src/widgets/tools.ts";

const LIVE = process.env.PSYCHE_LIVE_TESTS === "1";

interface UiCase {
  prompt: string;
  expect: "ui" | "text" | "update_ui";
  why: string;
}

const { cases } = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "agent-core",
      "test",
      "fixtures",
      "ui-vs-text-cases.json",
    ),
    "utf8",
  ),
) as { cases: UiCase[] };

describe.skipIf(!LIVE)("render_ui guidance, live", () => {
  it("picks UI, text or update_ui as the case set expects", { timeout: 5 * 60_000 }, async () => {
    const live = createLiveHaikuProvider();
    const tools = widgetTools({} as WidgetStore).map((t) => t.spec);
    const rows: {
      prompt: string;
      expect: string;
      got: string;
      ok: boolean;
      calls: string[];
      reply?: string;
    }[] = [];
    for (const c of cases) {
      const calls: string[] = [];
      let text = "";
      const messages: ModelMessage[] = [
        { role: "user", parts: [{ type: "text", text: c.prompt }] },
      ];
      // Up to three steps: a `list_ui` lookup is answered "no widgets in this chat" and the model
      // goes on, as the loop would (a fresh chat has none, so the next step is the real choice).
      for (let step = 0; step < 3; step++) {
        const requested: { id: string; name: string; input: unknown }[] = [];
        for await (const e of live.stream({
          model: "anthropic/claude-haiku-5-5",
          system: `You are Psyche, a personal agent that works for its owner inside a chat. Be brief.\n${UI_GUIDANCE}`,
          messages,
          tools,
          toolChoice: "auto",
          maxOutputTokens: 1500,
        }) as AsyncIterable<ModelEvent>) {
          if (e.type === "tool_call") requested.push({ id: e.id, name: e.name, input: e.input });
          if (e.type === "text_delta" && step === 0) text += e.text;
        }
        for (const r of requested) calls.push(r.name);
        if (requested.length === 0 || requested.some((r) => r.name !== "list_ui")) break;
        messages.push(
          {
            role: "assistant",
            parts: requested.map((r) => ({
              type: "tool_call",
              id: r.id,
              name: r.name,
              input: r.input,
            })),
          },
          {
            role: "tool",
            parts: requested.map((r) => ({
              type: "tool_result",
              callId: r.id,
              name: r.name,
              output: { widgets: [] },
            })),
          },
        );
      }
      const got = calls.includes("render_ui")
        ? "ui"
        : calls.includes("update_ui")
          ? "update_ui"
          : calls.includes("list_ui")
            ? "update_ui"
            : "text";
      rows.push({
        prompt: c.prompt,
        expect: c.expect,
        got,
        ok: got === c.expect,
        calls,
        ...(got === "text" ? { reply: text.slice(0, 160) } : {}),
      });
    }
    const passed = rows.filter((r) => r.ok).length;
    process.stdout.write(
      `${JSON.stringify({ passed, total: rows.length, usage: live.usage, rows }, null, 1)}\n`,
    );
    const approval = rows.find((r) => /approves sending/i.test(r.prompt));
    expect(approval?.got).not.toBe("ui");
  });
});
