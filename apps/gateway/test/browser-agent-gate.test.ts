import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting, updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Settings → Browser through the real `settings.set` handler, with an admin device: a change that
 * widens what the agent can do with the owner's sign-ins asks for an approval card and stores
 * nothing; a change that only narrows (or rewrites the same set) applies at once.
 */

const PARTITION = "browser.partition";
const ORIGINS = "browser.signedInOrigins";
const PORTS = "browser.devPreviewPorts";
const A = "https://a.example";
const B = "https://b.example";

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

const verifier: PresenceVerifier = { verify: async () => false };

async function boot() {
  home = mkdtempSync(join(tmpdir(), "psyche-browser-gate-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    presence: verifier,
  });
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, "admin-browser")).close();
  updateDevice(composed.gateway.context.db, "admin-browser", {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const admin = await desktopClient(composed.gateway, key, "admin-browser");
  clients.push(admin);
  return { admin, db: composed.gateway.context.db };
}

type Case = [name: string, key: string, stored: unknown, next: unknown];

const GATED: Case[] = [
  ["partition unset to profile", PARTITION, undefined, "profile"],
  ["partition clean to auto", PARTITION, "clean", "auto"],
  ["partition auto to profile", PARTITION, "auto", "profile"],
  ["origins unset to [a]", ORIGINS, undefined, [A]],
  ["origins [a] to [HTTPS://A.COM, b]", ORIGINS, [A], ["HTTPS://A.COM", B]],
  ["origins [a] to [a:8443]", ORIGINS, [A], ["https://a.example:8443"]],
  ["origins [a] to [b]", ORIGINS, [A], [B]],
  ["ports unset to [5173]", PORTS, undefined, [5173]],
  ["ports [3000] to [3001]", PORTS, [3000], [3001]],
];

const UNGATED: Case[] = [
  ["partition profile to clean", PARTITION, "profile", "clean"],
  ["partition profile to auto", PARTITION, "profile", "auto"],
  ["partition auto to clean", PARTITION, "auto", "clean"],
  ["origins remove one", ORIGINS, [A, B], [A]],
  ["origins clear all", ORIGINS, [A], []],
  [
    "origins [a,b] to the same set, spelled differently",
    ORIGINS,
    [A, B],
    ["HTTPS://B.EXAMPLE:443/", "https://A.example"],
  ],
  ["ports remove one", PORTS, [3000, 5173], [5173]],
];

describe("browser agent settings through settings.set", () => {
  it.each(GATED)("%s asks for a card and stores nothing", async (_n, key, stored, next) => {
    const { admin, db } = await boot();
    if (stored !== undefined) setSetting(db, key, stored);
    const res = await admin.request("settings.set", { key, value: next }, ik());
    expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(getSetting(db, key)?.value).toEqual(stored);
  });

  it.each(UNGATED)("%s applies without a card", async (_n, key, stored, next) => {
    const { admin, db } = await boot();
    setSetting(db, key, stored);
    const res = await admin.request("settings.set", { key, value: next }, ik());
    expect(res).toMatchObject({ ok: true });
    expect(getSetting(db, key)?.value).not.toEqual(stored);
  });
});
