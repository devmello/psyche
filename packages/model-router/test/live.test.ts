/**
 * Live provider tests. Skipped unless `PSYCHE_LIVE_TESTS=1`; each provider also needs its key
 * (or a running local server). They spend real tokens (a few hundred per provider).
 *
 *   PSYCHE_LIVE_TESTS=1 ANTHROPIC_API_KEY=… pnpm --filter @psyche/model-router test live
 *
 * Env keys are read through a test-only `KeySource`; the product reads keys from the vault.
 */
import { ResolvedSecret } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  AiSdkAdapter,
  accumulate,
  type KeySource,
  ModelRouter,
  type ProviderConfig,
  runCapabilityProbe,
} from "../src/index.ts";
import { textRequest, weatherTool } from "./helpers/adapters.ts";

const LIVE = process.env.PSYCHE_LIVE_TESTS === "1";

function envKeys(name: string): KeySource {
  return {
    resolve: async (_profile, target) => {
      const v = process.env[name];
      return v === undefined
        ? undefined
        : new ResolvedSecret(v, { credentialId: `env:${name}`, target });
    },
    redact: (t) => {
      const v = process.env[name];
      return v === undefined || v.length === 0 ? t : t.split(v).join("•••");
    },
  };
}

interface LiveCase {
  config: ProviderConfig;
  model: string;
  env?: string;
  baseUrlEnv?: string;
}

const CASES: LiveCase[] = [
  {
    config: { id: "anthropic", kind: "anthropic" },
    model: process.env.PSYCHE_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5",
    env: "ANTHROPIC_API_KEY",
  },
  {
    config: { id: "openai", kind: "openai" },
    model: process.env.PSYCHE_LIVE_OPENAI_MODEL ?? "gpt-6-luna",
    env: "OPENAI_API_KEY",
  },
  {
    config: { id: "google", kind: "google" },
    model: process.env.PSYCHE_LIVE_GOOGLE_MODEL ?? "gemini-3.8-flash",
    env: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    config: { id: "openrouter", kind: "openrouter" },
    model: process.env.PSYCHE_LIVE_OPENROUTER_MODEL ?? "openai/gpt-6-luna",
    env: "OPENROUTER_API_KEY",
  },
  {
    config: { id: "ollama", kind: "ollama" },
    model: process.env.PSYCHE_LIVE_OLLAMA_MODEL ?? "qwen3.8:27b",
    baseUrlEnv: "PSYCHE_LIVE_OLLAMA",
  },
  {
    config: {
      id: "ollama-anthropic",
      kind: "anthropic-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
    },
    model: process.env.PSYCHE_LIVE_OLLAMA_MODEL ?? "qwen3.8:27b",
    baseUrlEnv: "PSYCHE_LIVE_OLLAMA",
  },
  {
    config: {
      id: "llamacpp",
      kind: "openai-compatible",
      baseURL: process.env.PSYCHE_LIVE_OPENAI_COMPAT_URL ?? "http://127.0.0.1:8080/v1",
    },
    model: process.env.PSYCHE_LIVE_OPENAI_COMPAT_MODEL ?? "default",
    baseUrlEnv: "PSYCHE_LIVE_OPENAI_COMPAT_URL",
  },
];

for (const c of CASES) {
  const enabled =
    LIVE &&
    (c.env === undefined || process.env[c.env] !== undefined) &&
    (c.baseUrlEnv === undefined || process.env[c.baseUrlEnv] !== undefined);
  describe.skipIf(!enabled)(`live: ${c.config.id}`, () => {
    const keys = c.env === undefined ? undefined : envKeys(c.env);
    const config: ProviderConfig =
      c.env === undefined
        ? c.config
        : { ...c.config, profiles: [{ id: "env", credential: "{{cred:env}}" }] };
    const adapter = new AiSdkAdapter(config, keys === undefined ? {} : { keys });
    const ref = `${c.config.id}/${c.model}`;

    it("streams text with usage", { timeout: 120_000 }, async () => {
      const turn = await accumulate(adapter.stream(textRequest(ref)));
      expect(turn.finish).toMatchObject({ reason: "stop" });
      expect(turn.text().length).toBeGreaterThan(0);
    });

    it("calls a tool and round-trips the result", { timeout: 180_000 }, async () => {
      const first = await accumulate(
        adapter.stream({
          ...textRequest(ref),
          messages: [
            { role: "user", parts: [{ type: "text", text: "Weather in Paris? Use the tool." }] },
          ],
          tools: [weatherTool],
        }),
      );
      const call = first.toolCalls()[0];
      expect(call?.name).toBe("weather");
      if (call === undefined) return;
      const second = await accumulate(
        adapter.stream({
          ...textRequest(ref),
          tools: [weatherTool],
          messages: [
            { role: "user", parts: [{ type: "text", text: "Weather in Paris? Use the tool." }] },
            first.message(),
            {
              role: "tool",
              parts: [
                { type: "tool_result", callId: call.id, output: { tempC: 18, condition: "clear" } },
              ],
            },
          ],
        }),
      );
      expect(second.finish?.reason).toBe("stop");
      expect(second.text()).toMatch(/18/);
    });

    it.skipIf(c.config.kind !== "ollama" && c.config.kind !== "openai-compatible")(
      "runs the capability probe",
      { timeout: 900_000 },
      async () => {
        const router = new ModelRouter({ providers: [adapter], clock: new FakeClock() });
        const r = await runCapabilityProbe(router.provider(c.config.id) ?? adapter, ref);
        process.stderr.write(
          `probe ${ref}: ${r.status} ${r.passed}/${r.total} ${JSON.stringify(r.cases)}\n`,
        );
        expect(r.total).toBe(6);
      },
    );
  });
}
