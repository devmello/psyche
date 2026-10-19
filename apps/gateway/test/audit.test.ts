import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, type TestClient } from "./helpers.ts";

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-audit-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

describe("audit.* (S05 handlers mounted by the Gateway)", () => {
  it("lists, verifies and (admin only) exports the audit log", async () => {
    const c = await setup();
    await c.audit.append({
      kind: "config.changed",
      actor: { type: "system" },
      data: { key: "appearance.theme" },
    });
    await c.audit.append({
      kind: "approval.decided",
      actor: { type: "device", deviceId: "d1" },
      subject: { approvalId: "apr_1" },
      data: { decision: "allow" },
    });

    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    const all = await desk.call<{ entries: AuditEntry[] }>("audit.list", {
      kindPrefix: "approval.",
    });
    expect(all.entries.map((e) => e.kind)).toContain("approval.decided");
    expect(all.entries.every((e) => e.kind.startsWith("approval."))).toBe(true);
    const byApproval = await desk.call<{ entries: AuditEntry[] }>("audit.list", {
      approvalId: "apr_1",
    });
    expect(byApproval.entries).toHaveLength(1);
    expect(await desk.call("audit.verify", {})).toMatchObject({ ok: true });
    expect(await desk.request("audit.export", {})).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });

    const admin = await adminClient(c.gateway);
    clients.push(admin);
    const exported = await admin.call<{ format: string; data: string }>("audit.export", {
      format: "jsonl",
    });
    expect(exported.format).toBe("jsonl");
    const lines = exported.data
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditEntry);
    expect(lines.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["config.changed", "approval.decided"]),
    );
  });

  it("serves approval-friction metrics to operator.read devices", async () => {
    const c = await setup();
    await c.audit.append({
      kind: "tool_call.decided",
      actor: { type: "agent", runId: "run_1" },
      subject: { runId: "run_1" },
      data: {
        tool: "calendar.create",
        kind: "calendar_write",
        decision: "ask",
        rule: "mode:balanced/write",
        mode: "balanced",
      },
    });
    await c.audit.append({
      kind: "approval.created",
      actor: { type: "system" },
      subject: { approvalId: "apr_1" },
      data: { kind: "calendar_write" },
    });
    await c.audit.append({
      kind: "approval.decided",
      actor: { type: "device", deviceId: "d1" },
      subject: { approvalId: "apr_1" },
      data: { decision: "allow", latencyMs: 4200 },
    });
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    const r = await desk.call<{ asks: number; approveRate: number; p50AnswerMs: number }>(
      "audit.friction",
      {},
    );
    expect(r).toMatchObject({ asks: 1, approveRate: 1, p50AnswerMs: 4200 });
    expect(await desk.request("audit.friction", { since: "yesterday" })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });

  it("rejects malformed filters at the protocol layer", async () => {
    const c = await setup();
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    expect(await desk.request("audit.list", { limit: 5000 })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(await desk.request("audit.list", { since: "yesterday" })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });
});
