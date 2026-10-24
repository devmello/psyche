import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type ProviderConfig, probeEndpoint } from "../src/index.ts";

/** B4 probe for the subscription CLIs, against the fake CLI: installed, signed in, no secrets. */

const FAKE = resolve(import.meta.dirname, "fake-cli/fake-cli.mjs");
const clock = { now: () => Date.parse("2026-10-20T08:00:00Z") };
const claude: ProviderConfig = { id: "claude-code", kind: "claude-code", command: FAKE };
const codex: ProviderConfig = { id: "codex", kind: "codex", command: FAKE };

const probe = (config: ProviderConfig, env: Record<string, string>) =>
  probeEndpoint(config, { clock, cliEnv: { ...process.env, ...env } });

describe("subscription CLI probe", () => {
  it("reports Claude Code's version, sign-in method and plan, and its model aliases", async () => {
    const r = await probe(claude, {
      FAKE_CLI_AUTH: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "owner@example.com",
        orgId: "org-fixture",
        orgName: "Fixture Org",
        subscriptionType: "max",
      }),
    });
    expect(r).toMatchObject({
      state: "reachable",
      probedAt: "2026-10-20T08:00:00.000Z",
      server: `Claude Code 2.1.286 · ${FAKE} (claude.ai, max plan)`,
    });
    expect(r.models.map((m) => m.ref)).toEqual([
      "claude-code/default",
      "claude-code/opus",
      "claude-code/sonnet",
      "claude-code/haiku",
    ]);
    expect(r.models[0]?.capabilities).toMatchObject({
      toolCalling: true,
      vision: true,
      source: "catalog",
    });
    // #558: the catalog's context window, so Settings and the chat meter agree.
    expect(r.models.map((m) => m.capabilities.contextWindow)).toEqual([
      200_000, 200_000, 200_000, 200_000,
    ]);
    // Account details never leave the probe.
    expect(JSON.stringify(r)).not.toMatch(/owner@example\.com|org-fixture|Fixture Org/);
  });

  it("says when Claude Code is installed but not signed in", async () => {
    const r = await probe(claude, { FAKE_CLI_AUTH: JSON.stringify({ loggedIn: false }) });
    expect(r).toMatchObject({ state: "auth_failed", models: [] });
    expect(r.error).toContain("claude auth login");
  });

  it("checks the subscription login, not an API key from the environment", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "psyche-cli-probe-")), "log.jsonl");
    const r = await probe(claude, {
      ANTHROPIC_API_KEY: "fx-not-a-real-key",
      FAKE_CLI_LOG: log,
      FAKE_CLI_AUTH: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    });
    expect(r.state).toBe("reachable");
    const envs = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; env?: Record<string, unknown> })
      .filter((e) => e.kind === "env");
    expect(envs).toHaveLength(2);
    expect(envs.every((e) => e.env?.ANTHROPIC_API_KEY === null)).toBe(true);
  });

  it("reports Codex signed in with ChatGPT", async () => {
    const r = await probe(codex, {
      FAKE_CLI_VERSION: "codex-cli 0.162.0",
      FAKE_CLI_LOGIN: "Logged in using ChatGPT",
      FAKE_CLI_LOGIN_CODE: "0",
    });
    expect(r).toMatchObject({ state: "reachable", server: `Codex 0.162.0 · ${FAKE} (ChatGPT)` });
    expect(r.models.map((m) => m.ref)).toEqual(["codex/default"]);
    expect(r.models[0]?.capabilities.contextWindow).toBe(272_000);
  });

  it("says when Codex is not signed in", async () => {
    const r = await probe(codex, { FAKE_CLI_VERSION: "codex-cli 0.162.0" });
    expect(r).toMatchObject({ state: "auth_failed" });
    expect(r.error).toContain("codex login");
  });

  it("reports a CLI that is not installed as unreachable", async () => {
    const r = await probeEndpoint(
      { ...claude, command: join(import.meta.dirname, "no-such-cli") },
      { clock },
    );
    expect(r).toMatchObject({ state: "unreachable", models: [] });
    expect(r.error).toContain("not installed");
  });
});
