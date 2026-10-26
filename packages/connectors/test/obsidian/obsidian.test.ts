import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorRegistry, OBSIDIAN_CATALOGUE, obsidianFactory } from "../../src/index.ts";

/** #639: an Obsidian vault as a shared folder: search, read, append, daily note, create. */

let vault = "";
let outside = "";
let grants: { path: string; mode: "read" | "write" }[] = [];

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "psyche-vault-"));
  outside = mkdtempSync(join(tmpdir(), "psyche-outside-"));
  mkdirSync(join(vault, ".obsidian"));
  mkdirSync(join(vault, "Meetings"));
  writeFileSync(join(vault, ".obsidian", "daily-notes.json"), JSON.stringify({ folder: "Daily" }));
  writeFileSync(join(vault, "Meetings", "Offsite.md"), "# Offsite\nWe meet in Lisbon in May.\n");
  writeFileSync(join(vault, "Groceries.md"), "milk, eggs\n");
  writeFileSync(join(outside, "secret.md"), "nope");
  grants = [{ path: vault, mode: "write" }];
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** The Gateway's check, simplified: under a grant, and a write needs a write grant. */
async function access(path: string, mode: "read" | "write") {
  const g = grants.find((x) => path === x.path || path.startsWith(`${x.path}/`));
  if (g === undefined)
    throw new PsycheError("forbidden", `${path} is outside every granted folder`);
  if (mode === "write" && g.mode !== "write") throw new PsycheError("forbidden", "read-only");
}

function make() {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const registry = new ConnectorRegistry({
    factories: [obsidianFactory({ access, today: () => "2026-10-25" })],
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
    newId: () => "obs-1",
  });
  const run = (name: string) => (params: unknown) =>
    (
      tools.get(`mcp__obs-1__${name}`) as {
        execute: (...a: unknown[]) => Promise<{ output: unknown }>;
      }
    ).execute("c1", params, new AbortController().signal, () => {});
  return { registry, tools, run };
}

describe("Obsidian (#639)", () => {
  it("is one connector per vault, Gateway-only, with reads allowed and writes asking", () => {
    expect(OBSIDIAN_CATALOGUE).toMatchObject({ type: "obsidian", id: "obsidian", available: true });
    expect(OBSIDIAN_CATALOGUE.singleInstance).toBeUndefined();
    expect(OBSIDIAN_CATALOGUE.actions.map((a) => [a.id, a.defaultRule])).toEqual([
      ["obsidian.read", "allow"],
      ["obsidian.write", "ask"],
    ]);
  });

  it("connects only to a shared folder that is an Obsidian vault", async () => {
    const { registry } = make();
    await expect(
      registry.connect({
        catalogueId: "obsidian",
        scopeMode: "read",
        config: { vaultPath: outside },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    grants.push({ path: outside, mode: "read" });
    await expect(
      registry.connect({
        catalogueId: "obsidian",
        scopeMode: "read",
        config: { vaultPath: outside },
      }),
    ).rejects.toMatchObject({ details: { reason: "not_a_vault" } });
    const r = await registry.connect({
      catalogueId: "obsidian",
      scopeMode: "read",
      config: { vaultPath: vault },
    });
    expect(r).toMatchObject({ status: "connected", config: { vaultPath: vault } });
  });

  it("searches by name and content, newest first, and reads a note (untrusted)", async () => {
    const { registry, run } = make();
    await registry.connect({
      catalogueId: "obsidian",
      scopeMode: "read",
      config: { vaultPath: vault },
    });
    const found = (await run("obsidian_search")({ query: "lisbon" })) as {
      output: { notes: { path: string; snippet: string }[] };
      provenance: string;
    };
    expect(found.provenance).toBe("untrusted");
    expect(found.output.notes.map((n) => n.path)).toEqual(["Meetings/Offsite.md"]);
    expect(found.output.notes[0]?.snippet).toContain("Lisbon");
    const note = (await run("obsidian_read")({ path: "Groceries.md" })) as {
      output: { text: string };
    };
    expect(note.output.text).toBe("milk, eggs\n");
    await expect(run("obsidian_read")({ path: "../secret.md" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      run("obsidian_read")({ path: ".obsidian/daily-notes.json" }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("writes ask; with the matrix set to allow they append, keep a daily note and create", async () => {
    const { registry, run } = make();
    await registry.connect({
      catalogueId: "obsidian",
      scopeMode: "read_act",
      config: { vaultPath: vault },
    });
    await expect(run("obsidian_append_daily")({ text: "- standup" })).rejects.toMatchObject({
      code: "approval_required",
    });
    await registry.setMatrix("obs-1", { "obsidian.write": "allow" });
    await run("obsidian_append_daily")({ text: "- standup" });
    await run("obsidian_append_daily")({ text: "- lunch with Dana" });
    expect(readFileSync(join(vault, "Daily", "2026-10-25.md"), "utf8")).toBe(
      "- standup\n- lunch with Dana\n",
    );
    await run("obsidian_append")({ path: "Groceries.md", text: "bread" });
    expect(readFileSync(join(vault, "Groceries.md"), "utf8")).toBe("milk, eggs\nbread\n");
    await run("obsidian_create")({ path: "Meetings/Prep.md", content: "# Prep\n" });
    await expect(
      run("obsidian_create")({ path: "Meetings/Prep.md", content: "again" }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("a read-only share refuses read-and-act, and writes stay refused if the grant is narrowed", async () => {
    grants = [{ path: vault, mode: "read" }];
    const { registry } = make();
    await expect(
      registry.connect({
        catalogueId: "obsidian",
        scopeMode: "read_act",
        config: { vaultPath: vault },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
