import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, getSetting, getThread, openDb, updateDevice } from "@psyche/db";
import { DEFAULT_AUTO_MODE_ALLOWLIST } from "@psyche/model-router";
import type { PresenceVerifier } from "@psyche/permissions";
import type { ModelProvider } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { modelPinsFor, threadSettingsHandlers } from "../src/compose/threads.ts";
import type { Call } from "../src/context.ts";
import { needsPresence } from "../src/handlers/settings.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Turning Auto on is the owner's one-click choice (owner decision 2026-11-09): the default mode
 * applies at once, with no presence step and no refusal while the security records are untrusted.
 * Payments and the never list are enforced elsewhere; the model allowlist still gates Auto itself.
 */

describe("permissions.mode needs no presence", () => {
  it("is not a presence-gated key, while the other permission keys still are classed as before", () => {
    expect(needsPresence("permissions.mode")).toBe(false);
    expect(needsPresence("permissions.policy")).toBe(needsPresence("permissions.never"));
  });
});

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

// A verifier that rejects everything: with it enrolled, a gated change could never be approved.
const touchId: PresenceVerifier = { verify: async () => false };

async function boot() {
  home = mkdtempSync(join(tmpdir(), "psyche-mode-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    presence: touchId,
  });
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, "owner")).close();
  updateDevice(composed.gateway.context.db, "owner", {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const admin = await desktopClient(composed.gateway, key, "owner");
  clients.push(admin);
  return { c: composed, admin };
}

describe("settings.set permissions.mode", () => {
  it("applies at once with a presence verifier enrolled", async () => {
    const { c, admin } = await boot();
    const res = await admin.request(
      "settings.set",
      { key: "permissions.mode", value: "auto" },
      ik(),
    );
    expect(res).toMatchObject({ ok: true });
    expect(getSetting(c.gateway.context.db, "permissions.mode")?.value).toBe("auto");
  });

  it("applies while the security records are untrusted", async () => {
    const { c, admin } = await boot();
    // Report the records as untrusted to the presence gate (the seal itself is left alone).
    const state = c.gateway.context.securityState as unknown as { untrusted: () => string | null };
    expect(state).toBeDefined();
    state.untrusted = () => "tampered";
    const res = await admin.request(
      "settings.set",
      { key: "permissions.mode", value: "balanced" },
      ik(),
    );
    expect(res).toMatchObject({ ok: true });
  });

  it("still needs operator.admin: a write-only device is refused", async () => {
    const { c } = await boot();
    const key = newDeviceKey();
    (await desktopClient(c.gateway, key, "writer")).close();
    updateDevice(c.gateway.context.db, "writer", { scopes: ["operator.read", "operator.write"] });
    const writer = await desktopClient(c.gateway, key, "writer");
    clients.push(writer);
    const res = await writer.request(
      "settings.set",
      { key: "permissions.mode", value: "auto" },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

function routerWithPrimary(primary: string | undefined): ModelProvider {
  return {
    allowsAutoMode: (ref: string) => DEFAULT_AUTO_MODE_ALLOWLIST.some((p) => p.test(ref)),
    setThreadModel: async () => {},
    role: () => (primary === undefined ? undefined : { model: primary }),
  } as unknown as ModelProvider;
}

async function updateThreadWith(primary: string, params: Record<string, unknown>) {
  const db = openDb(":memory:");
  const thread = createThread(db, { kind: "side", sessionKey: "test:side" });
  const call = {
    ctx: { db, bus: { bumpStateVersion: () => {} } },
    emit: () => {},
  } as unknown as Call;
  const handler = threadSettingsHandlers(modelPinsFor(routerWithPrimary(primary)))[
    "threads.update"
  ];
  if (handler === undefined) throw new Error("threads.update is not registered");
  const run = () =>
    (handler.run as (c: Call, p: unknown) => Promise<unknown>)(call, {
      threadId: thread.id,
      ...params,
    });
  return { db, thread, run };
}

describe("threads.update: Auto and the model", () => {
  it("names the refusal so a client can offer a switch", async () => {
    const { run } = await updateThreadWith("lmstudio/tiny-7b", { permissionMode: "auto" });
    await expect(run()).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "auto_model_not_allowed", model: "lmstudio/tiny-7b" },
    });
  });

  it("takes Auto and an allowed model in one call (the one-tap switch)", async () => {
    const { db, thread, run } = await updateThreadWith("lmstudio/tiny-7b", {
      permissionMode: "auto",
      modelRef: "anthropic/claude-sonnet-5-5",
    });
    await run();
    const row = getThread(db, thread.id);
    expect(row?.permissionMode).toBe("auto");
    expect(row?.modelRef).toBe("anthropic/claude-sonnet-5-5");
  });

  it("keeps Auto off the smallest models: Haiku 5.5 gets the same refusal and offer", async () => {
    const { run } = await updateThreadWith("anthropic/claude-haiku-5-5", {
      permissionMode: "auto",
    });
    await expect(run()).rejects.toMatchObject({
      details: { reason: "auto_model_not_allowed", model: "anthropic/claude-haiku-5-5" },
    });
  });
});

describe("a tool call cannot switch the mode", () => {
  // The mode changes only through the owner's authenticated device (`settings.set` and
  // `threads.update` need a paired device's token). Nothing a tool or a model reaches may name
  // those methods, the setting, or write a thread's mode directly: a new tool that does must be
  // reviewed, so this fails first. The Gateway's own thread handlers (compose/threads.ts) and the
  // audit label (compose/changes.ts) are the only places in compose/ allowed to.
  const PATTERNS = [
    /permissions\.mode/,
    /["']threads\.update["']/,
    /["']settings\.set["']/,
    /updateThread\([^)]*\bpermissionMode\b/s,
    /setSetting\([^)]*permissions\.mode/s,
  ];

  function scan(dir: string, root: string, skip: ReadonlySet<string>, out: string[]) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p, root, skip, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !skip.has(e.name)) {
        const text = readFileSync(p, "utf8");
        if (PATTERNS.some((re) => re.test(text))) out.push(p.slice(root.length + 1));
      }
    }
  }

  it("keeps the mode methods out of the agent, tool, skill and plugin packages", () => {
    const root = join(__dirname, "../../../packages");
    const offenders: string[] = [];
    for (const pkg of ["agent-core", "mcp-host", "skills", "plugins", "harnesses", "connectors"]) {
      scan(join(root, pkg, "src"), root, new Set(), offenders);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps them out of the Gateway's tool and composition code", () => {
    const root = join(__dirname, "../src");
    const offenders: string[] = [];
    scan(join(root, "compose"), root, new Set(["threads.ts", "changes.ts"]), offenders);
    expect(offenders).toEqual([]);
  });

  it("the scan catches what it is meant to", () => {
    for (const bad of [
      'call("threads.update", { permissionMode: "auto" })',
      'updateThread(db, id, { permissionMode: "auto" })',
      'setSetting(db, "permissions.mode", "auto")',
      "x.settings = 'permissions.mode'",
    ]) {
      expect(
        PATTERNS.some((re) => re.test(bad)),
        bad,
      ).toBe(true);
    }
  });
});
