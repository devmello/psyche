import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  extractJson,
  InMemoryProbeStore,
  ModelRouter,
  modelsThatFit,
  RAM_TIERS,
  ramGuidance,
  runCapabilityProbe,
} from "../src/index.ts";

const done: ModelEvent = { type: "finish", reason: "stop" };
const text = (t: string): ModelEvent[] => [{ type: "text_delta", text: t }, done];
const call = (id: string, name: string, input: unknown): ModelEvent => ({
  type: "tool_call",
  id,
  name,
  input,
});

/** A model that answers each probe case correctly. */
function capable(request: ModelRequest): ModelEvent[] {
  const prompt = JSON.stringify(request.messages);
  if (request.messages.some((m) => m.role === "tool")) return text("It is 7°C with sleet in Oslo.");
  if (prompt.includes("Paris and Tokyo")) {
    return [
      call("c1", "get_weather", { city: "Paris" }),
      call("c2", "get_weather", { city: "Tokyo" }),
      done,
    ];
  }
  if (prompt.includes("Paris")) return [call("c1", "get_weather", { city: "Paris" }), done];
  if (prompt.includes("timer"))
    return [call("c1", "set_timer", { minutes: 15, label: "tea" }), done];
  if (prompt.includes("single word OK")) return text("OK");
  return text('```json\n{"fruit": "apple", "count": 3}\n```');
}

/** A chat model: describes tool calls in prose, answers JSON with strings. */
function chatty(request: ModelRequest): ModelEvent[] {
  if (request.messages.some((m) => m.role === "tool")) return text("It is 7 degrees with sleet.");
  if (JSON.stringify(request.messages).includes("single word OK")) return text("OK");
  return text('I would call get_weather({"city": "Paris"}). {"fruit": "apples", "count": "three"}');
}

describe("capability probe (B4)", () => {
  it("marks a model that passes the suite agent-capable", async () => {
    const fake = FakeModelProvider.script(Array(6).fill(capable), { id: "ollama" });
    const r = await runCapabilityProbe(fake, "ollama/qwen3.8:27b");
    expect(r.cases.filter((c) => !c.passed)).toEqual([]);
    expect(r).toMatchObject({ status: "agent-capable", passed: 6, total: 6 });
    expect(fake.requests.every((q) => q.temperature === 0)).toBe(true);
  });

  it("marks a model that cannot call tools chat-only", async () => {
    const fake = FakeModelProvider.script(Array(6).fill(chatty), { id: "ollama" });
    const r = await runCapabilityProbe(fake, "ollama/tiny:1b");
    expect(r.status).toBe("chat-only");
    expect(r.cases.find((c) => c.id === "single_tool_call")?.passed).toBe(false);
    expect(r.cases.find((c) => c.id === "no_tool_needed")?.passed).toBe(true);
  });

  it("counts failed calls as failed cases", async () => {
    const fake = FakeModelProvider.script(
      Array(6).fill([{ type: "finish", reason: "error", error: "network: refused" }]),
      { id: "ollama" },
    );
    const r = await runCapabilityProbe(fake, "ollama/down:1b");
    expect(r.passed).toBe(0);
    expect(r.cases[0]?.detail).toContain("network");
  });

  it("persists the verdict through the router and gates primary", async () => {
    const fake = FakeModelProvider.script(Array(6).fill(chatty), { id: "ollama" });
    const probes = new InMemoryProbeStore();
    const router = new ModelRouter({ providers: [fake], clock: new FakeClock(), probes });
    const r = await router.probe("ollama/tiny:1b");
    expect(r.probedAt).toBe(new FakeClock().iso());
    expect(probes.get("ollama/tiny:1b")?.status).toBe("chat-only");
    await expect(router.setRole("primary", { model: "ollama/tiny:1b" })).rejects.toMatchObject({
      code: "policy_denied",
    });
  });

  it("extracts JSON from fenced or chatty answers", () => {
    expect(extractJson('Sure: ```json\n{"a": 1}\n``` done')).toEqual({ a: 1 });
    expect(extractJson('{"a": {"b": 2}} trailing')).toEqual({ a: { b: 2 } });
    expect(extractJson("no json")).toBeUndefined();
  });
});

describe("local model guidance", () => {
  it("maps RAM to the documented tiers", () => {
    expect(ramGuidance(8)).toBeUndefined();
    expect(ramGuidance(16)?.guidance).toContain("9B");
    expect(ramGuidance(36)?.guidance).toContain("27–31B");
    expect(ramGuidance(128)?.guidance).toContain("120B");
    expect(RAM_TIERS.flatMap((t) => t.models.map((m) => m.label))).toContain("Qwen3.8-27B");
  });

  it("suggests only models that fit, largest first", () => {
    const fit = modelsThatFit(32).map((m) => m.minRamGb);
    expect(Math.max(...fit)).toBe(32);
    expect(fit).toEqual([...fit].sort((a, b) => b - a));
    expect(modelsThatFit(16).some((m) => m.label === "gpt-oss-120b")).toBe(false);
  });
});
