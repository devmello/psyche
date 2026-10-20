import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PsycheError, type SkillUpdateCheck } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { parseSkill } from "../src/frontmatter.ts";
import { createSkillsHandlers } from "../src/handlers.ts";
import { manifestOf } from "../src/manifest.ts";
import { deniedToolsFromPolicy, policyViolations } from "../src/policy.ts";
import { hasBlockingFindings } from "../src/scanner.ts";
import { readSkillDir } from "../src/tree.ts";
import { approve, setup, skillMd, tempDir, writeSkill } from "./helpers.ts";

/** Feature T2: manifest, install policy, update detection. */

const DECLARING = `allowed-tools: [files.read]
requires:
  tools: [email.*]
permissions: [send_email, file_write]
prompts: [prompts/draft.md]
`;

async function rejects(p: Promise<unknown>): Promise<PsycheError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PsycheError);
    return e as PsycheError;
  }
  throw new Error("expected a rejection");
}

describe("manifest", () => {
  it("merges declared tools, sorts permissions and checks prompt files", () => {
    const dir = writeSkill(tempDir(), "drafts", {
      frontmatter: DECLARING,
      files: { "prompts/draft.md": "Draft politely.\n" },
    });
    const parsed = parseSkill(skillMd("drafts", { frontmatter: DECLARING }));
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const m = manifestOf(parsed.skill.meta, readSkillDir(dir));
    expect(m).toEqual({
      ok: true,
      manifest: {
        tools: ["email.*", "files.read"],
        permissions: ["file_write", "send_email"],
        prompts: ["prompts/draft.md"],
      },
    });
  });

  it("rejects unknown approval kinds, missing prompt files and escaping paths", () => {
    const fm = "permissions: [send_email, root_shell]\nprompts: [prompts/missing.md, ../x.md]\n";
    const parsed = parseSkill(skillMd("bad", { frontmatter: fm }));
    if (!parsed.ok) throw new Error(parsed.errors.join());
    const m = manifestOf(parsed.skill.meta, readSkillDir(writeSkill(tempDir(), "bad")));
    expect(m.ok).toBe(false);
    const errors = m.ok ? [] : m.errors.join("\n");
    expect(errors).toContain('"root_shell" is not an approval kind');
    expect(errors).toContain('"prompts/missing.md" is not in the skill folder');
    expect(errors).toContain('"../x.md" must be a relative path');
  });

  it("an installed skill with an invalid manifest is invalid and never loads", async () => {
    const t = setup();
    writeSkill(t.bundledDir, "broken", { frontmatter: "prompts: [nope.md]\n" });
    const [d] = await t.loader.listDetailed();
    expect(d?.status).toBe("invalid");
    expect(await t.loader.load("broken")).toBeUndefined();
  });
});

describe("install policy", () => {
  it("forbids host exec, skill installs and policy changes by default", () => {
    const m = { tools: ["skills.install", "files.read"], permissions: ["exec_host"], prompts: [] };
    expect(policyViolations(m)).toEqual([
      "asks for the exec_host permission, which skills may not use",
      "declares the tool skills.install, which the policy denies (skills.install)",
    ]);
  });

  it("denied tool rules overlap declared families both ways", () => {
    const deniedTools = deniedToolsFromPolicy({
      deny: ["email.send", "mcp__*", "exec(rm *)", "origin:*.bank"],
    });
    expect(deniedTools).toEqual(["email.send", "mcp__*"]);
    const m = (tools: string[]) => ({ tools, permissions: [], prompts: [] });
    expect(policyViolations(m(["email.*"]), { deniedTools })).toHaveLength(1);
    expect(policyViolations(m(["mcp__github__issues"]), { deniedTools })).toHaveLength(1);
    expect(policyViolations(m(["email.read", "files.read"]), { deniedTools })).toEqual([]);
  });

  it("proposeInstall refuses a manifest that asks for more, before any card", async () => {
    const t = setup({ installPolicy: { deniedTools: ["email.send"] } });
    const handlers = createSkillsHandlers(t.loader, { broker: t.broker });
    const src = writeSkill(tempDir(), "greedy", {
      frontmatter: "allowed-tools: [email.send]\npermissions: [send_email, exec_host]\n",
    });
    const err = await rejects(
      handlers["skills.proposeInstall"]({ source: { kind: "path", path: src } }),
    );
    expect(err.code).toBe("policy_denied");
    const details = err.details as { violations: string[] };
    expect(details.violations).toEqual([
      "asks for the exec_host permission, which skills may not use",
      "declares the tool email.send, which the policy denies (email.send)",
    ]);
    expect(await t.broker.list()).toEqual([]);
  });

  it("install re-checks the policy, and a tightened policy blocks an installed skill", async () => {
    let policy: { deniedTools: string[] } = { deniedTools: [] };
    const t = setup({ installPolicy: () => policy });
    const src = writeSkill(tempDir(), "mailer", { frontmatter: "allowed-tools: [email.send]\n" });
    const p1 = await t.loader.proposeInstall({ kind: "path", path: src });
    const a1 = await approve(t.broker, t.clock, p1);
    policy = { deniedTools: ["email.*"] };
    expect((await rejects(t.loader.install(p1.id, a1))).code).toBe("policy_denied");

    policy = { deniedTools: [] };
    const p2 = await t.loader.proposeInstall({ kind: "path", path: src });
    await t.loader.install(p2.id, await approve(t.broker, t.clock, p2));
    expect((await t.loader.list()).find((s) => s.name === "mailer")?.enabled).toBe(true);
    policy = { deniedTools: ["email.send"] };
    const d = (await t.loader.listDetailed()).find((s) => s.name === "mailer");
    expect(d?.status).toBe("blocked");
    expect(d?.reasons.join()).toContain("email.send");
    expect((await t.loader.load("mailer"))?.enabled).toBe(false);
  });

  it("the trust card lists the manifest and the binding covers it", async () => {
    const t = setup();
    const handlers = createSkillsHandlers(t.loader, { broker: t.broker });
    const src = writeSkill(tempDir(), "drafts", {
      frontmatter: DECLARING,
      files: { "prompts/draft.md": "Draft politely.\n" },
    });
    const { proposal, approval } = await handlers["skills.proposeInstall"]({
      source: { kind: "path", path: src },
    });
    expect(proposal.manifest.permissions).toEqual(["file_write", "send_email"]);
    expect(approval.details).toMatchObject({
      permissions: ["file_write", "send_email"],
      tools: ["email.*", "files.read"],
      prompts: ["prompts/draft.md"],
    });
    expect(approval.deviceOnly).toBe(true);
    // Same files, but a binding computed without the manifest does not verify.
    const { skillInstallBinding } = await import("../src/binding.ts");
    const bare = skillInstallBinding({
      name: "drafts",
      scope: "home",
      source: { kind: "path", path: src },
      treeHash: proposal.hash,
      tools: [],
      permissions: [],
      prompts: [],
    });
    expect(bare.bindingHash).not.toBe(proposal.bindingHash);
  });
});

describe("update detection", () => {
  it("reports a changed source and a changed manifest without installing", async () => {
    const t = setup();
    const updates: SkillUpdateCheck[] = [];
    const handlers = createSkillsHandlers(t.loader, {
      broker: t.broker,
      onUpdate: (u) => updates.push(u),
    });
    const root = tempDir();
    const src = writeSkill(root, "notes");
    const p = await t.loader.proposeInstall({ kind: "path", path: src });
    await t.loader.install(p.id, await approve(t.broker, t.clock, p));

    const same = await handlers["skills.checkUpdates"]({});
    expect(same.updates).toMatchObject([
      { name: "notes", updateAvailable: false, manifestChanged: false },
    ]);
    expect(updates).toEqual([]);

    writeFileSync(
      join(src, "SKILL.md"),
      skillMd("notes", { frontmatter: "permissions: [file_write]\n" }),
    );
    const changed = await handlers["skills.checkUpdates"]({ name: "notes" });
    expect(changed.updates).toMatchObject([
      { name: "notes", installedHash: p.hash, updateAvailable: true, manifestChanged: true },
    ]);
    expect(updates.map((u) => u.name)).toEqual(["notes"]);
    // Nothing was installed: the approved files still load, and Settings sees the update.
    const d = (await t.loader.listDetailed()).find((s) => s.name === "notes");
    expect(d?.hash).toBe(p.hash);
    expect(d?.status).toBe("active");
    expect(d?.update?.updateAvailable).toBe(true);
  });

  it("a source that is gone is an error on that skill, not a throw", async () => {
    const t = setup();
    const root = tempDir();
    const src = writeSkill(root, "gone");
    const p = await t.loader.proposeInstall({ kind: "path", path: src });
    await t.loader.install(p.id, await approve(t.broker, t.clock, p));
    const { rmSync } = await import("node:fs");
    rmSync(src, { recursive: true });
    const [u] = await t.loader.checkUpdates();
    expect(u?.updateAvailable).toBe(false);
    expect(u?.error).toBeTruthy();
  });
});

describe("injection corpus: malicious SKILL.md", () => {
  const corpus = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../tests/corpus/injection/cases/mcp-skills-memory.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { cases: { id: string; vector: string; payload: { content: string } }[] };
  const skillCases = corpus.cases.filter((c) => c.vector === "skill_file");

  it("has skill_file cases", () => {
    expect(skillCases.length).toBeGreaterThan(0);
  });

  for (const c of skillCases) {
    it(`${c.id}: installs disabled and never reaches the prompt`, async () => {
      const t = setup();
      const parsed = parseSkill(c.payload.content);
      if (!parsed.ok) throw new Error(parsed.errors.join());
      const name = parsed.skill.meta.name;
      const src = join(tempDir(), name);
      mkdirSync(src);
      writeFileSync(join(src, "SKILL.md"), c.payload.content);
      const p = await t.loader.proposeInstall({ kind: "path", path: src });
      expect(hasBlockingFindings(p.findings)).toBe(true);
      expect(p.findings.map((f) => f.rule)).toEqual(
        expect.arrayContaining(["pipe-to-shell", "agent-directed-instruction"]),
      );
      const s = await t.loader.install(p.id, await approve(t.broker, t.clock, p));
      expect(s.enabled).toBe(false);
      expect((await t.loader.promptIndex()).included).not.toContain(name);
      // The owner's switch cannot turn a skill with high findings on.
      expect((await rejects(t.loader.setEnabled(name, true))).code).toBe("policy_denied");
    });
  }
});
