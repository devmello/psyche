import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog } from "@psyche/audit";
import { PsycheError } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CallContexts } from "../src/compose/call-context.ts";
import { fetchLimit } from "../src/compose/fetch-origins.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { AuditedLimit, createRateLimits, DEFAULT_RATE_LIMITS } from "../src/compose/rate-limits.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { resolveConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";

/** Security §10 rate limits: inbound chat 30/minute/sender, `fetch` 60/minute/Task. */

let t = 0;
const clock = { now: () => t };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AuditedLimit", () => {
  it("admits perMinute events per key, then refuses and audits once per window", async () => {
    t = 0;
    const audit = createAuditLog({ clock });
    const limit = new AuditedLimit("inbound_chat", 3, { audit, clock });
    for (let i = 0; i < 3; i++) expect(limit.admit("a", { senderId: "a" })).toBe(true);
    expect(limit.admit("a", { senderId: "a" })).toBe(false);
    expect(limit.admit("a", { senderId: "a" })).toBe(false);
    // Another key has its own window.
    expect(limit.admit("b")).toBe(true);
    await flush();
    const entries = await audit.query({ kind: "rate_limit.exceeded" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data).toEqual({ limit: "inbound_chat", perMinute: 3, senderId: "a" });

    // The window slides: a minute later the key is admitted again; a new flood is audited again.
    t += 60_001;
    for (let i = 0; i < 3; i++) expect(limit.admit("a")).toBe(true);
    expect(limit.admit("a")).toBe(false);
    await flush();
    expect(await audit.query({ kind: "rate_limit.exceeded" })).toHaveLength(2);
  });

  it("defaults are the security §10 values", () => {
    const limits = createRateLimits(undefined, { audit: createAuditLog({ clock }), clock });
    expect(DEFAULT_RATE_LIMITS).toEqual({ inboundChatPerMinute: 30, fetchPerMinute: 60 });
    expect(limits.inboundChat.perMinute).toBe(30);
    expect(limits.fetch.perMinute).toBe(60);
  });
});

describe("web_fetch admission per Task", () => {
  function services(perMinute: number) {
    const audit = createAuditLog({ clock });
    const calls = new CallContexts();
    const ctx = (callId: string, taskId?: string) =>
      ({
        callId,
        threadId: "thr_main",
        runId: "run_1",
        ...(taskId === undefined ? {} : { taskId }),
      }) as never;
    const contexts = new Map<string, unknown>();
    // Only `get` is used by the limit.
    (calls as unknown as { get: (id: string) => unknown }).get = (id) => contexts.get(id);
    const s = {
      calls,
      rateLimits: createRateLimits({ fetchPerMinute: perMinute }, { audit, clock }),
    } as unknown as Pick<ComposeServices, "calls" | "rateLimits">;
    return { s, audit, add: (id: string, task?: string) => contexts.set(id, ctx(id, task)) };
  }

  it("refuses the call past the limit with rate_limited, per Task, and audits it", async () => {
    t = 0;
    const { s, audit, add } = services(2);
    const gate = fetchLimit(s);
    for (const id of ["c1", "c2", "c3", "d1"]) add(id, id.startsWith("c") ? "task_a" : "task_b");
    gate({ callId: "c1" });
    gate({ callId: "c2" });
    let err: unknown;
    try {
      gate({ callId: "c3" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("rate_limited");
    expect((err as PsycheError).retryable).toBe(true);
    // Another Task is not affected.
    expect(() => gate({ callId: "d1" })).not.toThrow();
    await flush();
    expect((await audit.query({ kind: "rate_limit.exceeded" }))[0]?.data).toEqual({
      limit: "fetch",
      perMinute: 2,
      taskId: "task_a",
    });
  });

  it("an interactive turn (no Task) is limited per thread", () => {
    t = 0;
    const { s, add } = services(1);
    const gate = fetchLimit(s);
    add("x1");
    add("x2");
    gate({ callId: "x1" });
    expect(() => gate({ callId: "x2" })).toThrow(/limited to 1 requests a minute/);
  });
});

describe("gateway.rateLimits in config.json", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  function homeWith(gateway: unknown): string {
    const home = mkdtempSync(join(tmpdir(), "psyche-rl-"));
    homes.push(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ gateway }));
    return home;
  }

  it("reads the limits and rejects bad values", () => {
    const home = homeWith({ rateLimits: { inboundChatPerMinute: 5 } });
    expect(resolveConfig({ PSYCHE_HOME: home }).rateLimits).toEqual({ inboundChatPerMinute: 5 });
    for (const bad of [{ inboundChatPerMinute: 0 }, { fetchPerMinute: 1.5 }, { other: 3 }, 7]) {
      expect(() => resolveConfig({ PSYCHE_HOME: homeWith({ rateLimits: bad }) })).toThrow(
        /gateway\.rateLimits/,
      );
    }
  });

  it("the composed services carry the configured limits", async () => {
    const home = homeWith({ rateLimits: { fetchPerMinute: 7 } });
    let seen: ComposeServices | undefined;
    let composed: ComposedGateway | undefined;
    try {
      composed = await composeGateway({
        logger: silentLogger,
        retentionIntervalMs: 0,
        background: false,
        config: { ...resolveConfig({ PSYCHE_HOME: home }), port: 0, webRoot: null },
        model: { provider: new FakeModelProvider(), model: "fake/model" },
        parts: [
          (s) => {
            seen = s;
            return {};
          },
        ],
      });
      expect(seen?.rateLimits.fetch.perMinute).toBe(7);
      expect(seen?.rateLimits.inboundChat.perMinute).toBe(30);
    } finally {
      await composed?.stop("test");
    }
  });
});
