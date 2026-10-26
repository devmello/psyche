import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppleHelper,
  appleFactories,
  type ConnectorEvent,
  ConnectorRegistry,
  type ConnectorRegistryOptions,
  obsidianFactory,
} from "../../src/index.ts";

/** #727: `connectors.configure` merges settings; Shortcuts rules, Obsidian folders, staged files. */

interface Invocation {
  capability: string;
  params: unknown;
}

/** A paired helper that offers Shortcuts and Mail, with every grant given. */
function fakeHelper(results: Record<string, unknown> = {}) {
  const calls: Invocation[] = [];
  const helper: AppleHelper = {
    nodeId: "node_mac",
    capabilities: [
      "permissions.status",
      "shortcuts.list",
      "shortcuts.run",
      "mail.search",
      "mail.save_attachments",
    ],
    invoke: async (capability, params) => {
      calls.push({ capability, params });
      if (capability === "permissions.status") {
        return { ok: true, result: { automation: { "com.apple.mail": "granted" } } };
      }
      return { ok: true, result: results[capability] ?? { capability } };
    },
  };
  return { helper, calls };
}

function make(opts: {
  factories: ConnectorRegistryOptions["factories"];
  events?: ConnectorEvent[];
}) {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const receipts: unknown[] = [];
  let n = 0;
  const registry = new ConnectorRegistry({
    factories: opts.factories,
    context: {
      clock: new FakeClock(),
      fetch,
      tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
    },
    tools: {
      list: () => [],
      get: () => undefined,
      register: (r) => {
        tools.set(r.spec.name, r as never);
        return () => tools.delete(r.spec.name);
      },
    },
    broker: {
      get: async () => undefined,
      recordReceipt: async (i: unknown) => {
        receipts.push(i);
        return { id: `r${receipts.length}` };
      },
    } as never,
    onEvent: (e) => opts.events?.push(e),
    newId: () => `c-${++n}`,
  });
  const run = (name: string) => (params: unknown) => {
    const t = tools.get(name);
    if (t === undefined) throw new Error(`${name} is not registered`);
    return t.execute("c1", params, new AbortController().signal, () => {}) as Promise<{
      output: unknown;
      receiptId?: string;
    }>;
  };
  return { registry, tools, receipts, run };
}

describe("ConnectorRegistry.configure (#727)", () => {
  it("merges key by key, null removes a key, and announces the change", async () => {
    const { helper } = fakeHelper();
    const events: ConnectorEvent[] = [];
    const { registry } = make({ factories: appleFactories({ helper: () => helper }), events });
    await registry.connect({ catalogueId: "apple-shortcuts", scopeMode: "read_act" });
    await registry.configure("c-1", { shortcutRules: { S1: "allow" }, note: "kept" });
    const r = await registry.configure("c-1", { note: null, shortcutRules: { S2: "off" } });
    // A key's value is replaced whole; `null` removed `note`; the Gateway's own keys stay.
    expect(r.config).toMatchObject({ nodeId: "node_mac", shortcutRules: { S2: "off" } });
    expect(r.config).not.toHaveProperty("note");
    expect(events.filter((e) => e.type === "configured")).toEqual([
      { type: "configured", connectorId: "c-1", keys: ["shortcutRules", "note"] },
      { type: "configured", connectorId: "c-1", keys: ["note", "shortcutRules"] },
    ]);
  });

  it("refuses secrets, keys the Gateway manages, and bad connector settings", async () => {
    const { helper } = fakeHelper();
    const { registry } = make({ factories: appleFactories({ helper: () => helper }) });
    await registry.connect({ catalogueId: "apple-shortcuts", scopeMode: "read_act" });
    for (const patch of [
      { apiKey: "sk-live-123" },
      { authToken: "abc" },
      { nested: { clientSecret: "x" } },
      { headers: [{ authorization: "Bearer t" }] },
    ]) {
      await expect(registry.configure("c-1", patch)).rejects.toMatchObject({
        code: "invalid_params",
        details: { reason: "secret_in_config" },
      });
    }
    // The error names the key, never the value.
    await registry.configure("c-1", { apiKey: "sk-live-123" }).catch((err: PsycheError) => {
      expect(err.message).not.toContain("sk-live-123");
    });
    await expect(registry.configure("c-1", { nodeId: "node_other" })).rejects.toMatchObject({
      details: { reason: "managed_key" },
    });
    await expect(
      registry.configure("c-1", { shortcutRules: { S1: "always" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(registry.configure("c-1", { shortcutRules: ["S1"] })).rejects.toMatchObject({
      code: "invalid_params",
    });
    // A placeholder and a removal are fine.
    const r = await registry.configure("c-1", {
      authToken: "{{cred:things-token}}",
      password: null,
    });
    expect(r.config.authToken).toBe("{{cred:things-token}}");
    expect((await registry.get("c-1")).config).not.toHaveProperty("shortcutRules");
  });
});

describe("Shortcuts rules (#727)", () => {
  it("off never runs, ask asks, allow runs with a receipt; a matrix deny still wins", async () => {
    const { helper, calls } = fakeHelper({ "shortcuts.run": { output: "ok" } });
    const { registry, tools, receipts, run } = make({
      factories: appleFactories({ helper: () => helper }),
    });
    await registry.connect({ catalogueId: "apple-shortcuts", scopeMode: "read_act" });
    const name = "mcp__c-1__shortcuts_run";
    const describe = (id: string) =>
      (
        tools.get(name) as unknown as {
          describeCall: (p: unknown) => { sideEffect?: string };
        }
      ).describeCall({ id });

    // Default: a shortcut can do anything, so it is destructive and asks.
    expect(describe("S1").sideEffect).toBe("destructive");
    await expect(run(name)({ id: "S1" })).rejects.toMatchObject({ code: "approval_required" });

    await registry.configure("c-1", {
      shortcutRules: { S1: "allow", S2: "ask", S3: "off" },
    });
    // The re-created tool sees the rules.
    expect(describe("S1").sideEffect).toBe("write");
    expect(describe("S2").sideEffect).toBe("destructive");
    // Off: refused before an approval card could be shown.
    expect(() => describe("S3")).toThrow(/turned this shortcut off/);
    calls.length = 0;
    const out = await run(name)({ id: "S1", input: "hi" });
    expect(out.output).toEqual({ output: "ok" });
    expect(out.receiptId).toBe("r1");
    expect(receipts).toHaveLength(1);
    expect(calls).toEqual([{ capability: "shortcuts.run", params: { id: "S1", input: "hi" } }]);
    await expect(run(name)({ id: "S2" })).rejects.toMatchObject({ code: "approval_required" });
    await expect(run(name)({ id: "S3" })).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "shortcut_off" },
    });
    // Another shortcut keeps the default.
    await expect(run(name)({ id: "S9" })).rejects.toMatchObject({ code: "approval_required" });

    await registry.setMatrix("c-1", { "shortcuts.run": "deny" });
    await expect(run(name)({ id: "S1" })).rejects.toMatchObject({ code: "policy_denied" });
    expect(calls.filter((c) => c.capability === "shortcuts.run")).toHaveLength(1);
  });
});

describe("Obsidian settings (#727)", () => {
  let vault = "";
  let other = "";
  const grants: string[] = [];
  beforeEach(() => {
    vault = realpathSync(mkdtempSync(join(tmpdir(), "psyche-vault-")));
    other = realpathSync(mkdtempSync(join(tmpdir(), "psyche-notvault-")));
    mkdirSync(join(vault, ".obsidian"));
    grants.splice(0, grants.length, vault, other);
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  const access = async (path: string) => {
    if (!grants.some((g) => path === g || path.startsWith(`${g}/`))) {
      throw new PsycheError("forbidden", "outside every granted folder");
    }
  };

  it("keeps the daily note in config.dailyFolder, inside the vault, and re-checks vaultPath", async () => {
    const { registry, run } = make({
      factories: [obsidianFactory({ access, today: () => "2026-10-25" })],
    });
    await registry.connect({
      catalogueId: "obsidian",
      scopeMode: "read_act",
      config: { vaultPath: vault },
    });
    await registry.setMatrix("c-1", { "obsidian.write": "allow" });
    const r = await registry.configure("c-1", { dailyFolder: "/Journal/Daily/" });
    expect(r.config).toEqual({ vaultPath: vault, dailyFolder: "Journal/Daily" });
    await run("mcp__c-1__obsidian_append_daily")({ text: "- standup" });
    expect(readFileSync(join(vault, "Journal", "Daily", "2026-10-25.md"), "utf8")).toBe(
      "- standup\n",
    );

    await expect(registry.configure("c-1", { dailyFolder: "../elsewhere" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(registry.configure("c-1", { vaultPath: other })).rejects.toMatchObject({
      details: { reason: "not_a_vault" },
    });
    grants.splice(0, grants.length);
    await expect(registry.configure("c-1", { dailyFolder: "Notes" })).rejects.toMatchObject({
      code: "forbidden",
    });
    // Nothing refused was stored.
    expect((await registry.get("c-1")).config).toEqual({
      vaultPath: vault,
      dailyFolder: "Journal/Daily",
    });
  });
});

describe("mail.save_attachments to the Library (#727)", () => {
  const staged = {
    files: [
      {
        name: "bill.pdf",
        size: 10,
        path: null,
        stagedPath: "/home/.psyche/helper/staging/mail-1/bill.pdf",
        mimeType: "application/pdf",
        libraryItemId: null,
      },
      {
        name: "photo.jpg",
        size: 20,
        path: null,
        stagedPath: "/home/.psyche/helper/staging/mail-1/photo.jpg",
        libraryItemId: null,
      },
    ],
    provenance: "untrusted",
  };

  it("imports staged files and never shows the model the staging path", async () => {
    const { helper } = fakeHelper({ "mail.save_attachments": staged });
    const imported: unknown[] = [];
    const { registry, run } = make({
      factories: appleFactories({
        helper: () => helper,
        importStaged: async (file, source) => {
          imported.push({ file, source });
          if (file.name === "photo.jpg") throw new PsycheError("invalid_params", "too large");
          return "lib_1";
        },
      }),
    });
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    await registry.setMatrix("c-1", { "mail.organize": "allow" });
    const out = await run("mcp__c-1__mail_save_attachments")({ id: "m1" });
    expect(out.output).toEqual({
      files: [{ name: "bill.pdf", size: 10, path: null, libraryItemId: "lib_1" }],
      notSaved: [{ name: "photo.jpg", reason: "too large" }],
      provenance: "untrusted",
    });
    expect(JSON.stringify(out.output)).not.toContain("staging");
    expect(imported).toEqual([
      {
        file: {
          stagedPath: staged.files[0]?.stagedPath,
          name: "bill.pdf",
          mimeType: "application/pdf",
        },
        source: { connectorId: "c-1", ref: "m1" },
      },
      {
        file: {
          stagedPath: staged.files[1]?.stagedPath,
          name: "photo.jpg",
          mimeType: "application/octet-stream",
        },
        source: { connectorId: "c-1", ref: "m1" },
      },
    ]);
  });

  it("reports staged files as not saved without a Library, and leaves folder saves alone", async () => {
    const { helper } = fakeHelper({ "mail.save_attachments": staged });
    const { registry, run } = make({ factories: appleFactories({ helper: () => helper }) });
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    await registry.setMatrix("c-1", { "mail.organize": "allow" });
    const out = (await run("mcp__c-1__mail_save_attachments")({ id: "m1" })).output as {
      files: unknown[];
      notSaved: { name: string }[];
    };
    expect(out.files).toEqual([]);
    expect(out.notSaved.map((f) => f.name)).toEqual(["bill.pdf", "photo.jpg"]);

    const folder = fakeHelper({
      "mail.save_attachments": {
        files: [{ name: "a.txt", size: 1, path: "/Users/me/Taxes/a.txt", libraryItemId: null }],
      },
    });
    const f = make({ factories: appleFactories({ helper: () => folder.helper }) });
    await f.registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    await f.registry.setMatrix("c-1", { "mail.organize": "allow" });
    expect((await f.run("mcp__c-1__mail_save_attachments")({ id: "m1" })).output).toEqual({
      files: [{ name: "a.txt", size: 1, path: "/Users/me/Taxes/a.txt", libraryItemId: null }],
    });
  });
});
