import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { AuthorKeyStore, AuthorRing, authorNameSkeleton } from "../src/authors.ts";
import {
  type BundleSigningKey,
  buildBundle,
  canonicalJson,
  keyIdOf,
  MAX_BUNDLE_BYTES,
  signingBytes,
  verifyBundle,
} from "../src/bundle.ts";
import { checkBundleUrl, fetchBundleText, isPrivateAddress } from "../src/bundle-url.ts";
import { createSkillsHandlers, quoteForSummary, type SkillsGates } from "../src/handlers.ts";
import { type FsSkillLoader, writeTree } from "../src/loader.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { provenanceOfTrust } from "../src/tools.ts";
import { foldConflict, type SkillTree, TreeBuilder } from "../src/tree.ts";
import { widenedBy } from "../src/widen.ts";
import { approve, setup, skillMd, tempDir, writeSkill } from "./helpers.ts";

/** The independent review's findings on shared bundles (M1 to M5, L1 to L8). */

const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-11-04T12:00:00Z");
const SKILL = (name: string, fm = "") => skillMd(name, { frontmatter: fm });

async function rejects(p: Promise<unknown> | (() => unknown)): Promise<PsycheError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(PsycheError);
    return e as PsycheError;
  }
  throw new Error("expected a rejection");
}

function authorKey(name: string): BundleSigningKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = privateKey.export({ format: "jwk" }).x as string;
  return {
    author: { name, keyId: keyIdOf(x), publicKey: x },
    sign: (data) => sign(null, data, privateKey).toString("base64url"),
  };
}

/** The same key signing under another claimed name. */
const renamed = (k: BundleSigningKey, name: string): BundleSigningKey => ({
  author: { ...k.author, name },
  sign: k.sign,
});

function treeOf(files: Record<string, string>): SkillTree {
  const b = new TreeBuilder();
  for (const [p, t] of Object.entries(files)) b.add(p, enc(t));
  return b.tree;
}
const simple = (name = "tidy", fm = "", extra = "Extra.\n") =>
  treeOf({ "SKILL.md": SKILL(name, fm), "notes/extra.md": extra });

// biome-ignore lint/suspicious/noExplicitAny: tests reach into the JSON to tamper with it
const parse = (text: string) => JSON.parse(text) as Record<string, any>;

const ROLE = (tools: string, extra = "") => `metadata:
  psyche:
    specialist:
      role: researcher
      label: Researcher
      tools: [${tools}]
      result: findings
      caps:
        maxHours: 2
${extra}`;

/** An approved card to record the agent-made skill's receipt against. */
async function agentApproval(o: {
  broker: Parameters<typeof approve>[0];
  clock: Parameters<typeof approve>[1];
}) {
  return approve(o.broker, o.clock, {
    name: "agent-made",
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "k",
  } as never);
}

function exportOf(loader: FsSkillLoader, name: string, author?: string) {
  return loader.exportSkill(name, author, loader.previewExport(name).treeHash);
}

async function owner(extra: Parameters<ReturnType<typeof setup>["make"]>[0] = {}) {
  const a = setup();
  const psycheHome = join(a.base, "home");
  const events: { kind: string; keyId: string; skill?: string; treeHash?: string }[] = [];
  const loader = a.make({
    psycheHome,
    onAuthorChange: (e) => events.push(e),
    ...extra,
  });
  const approveWorkspace = async (name: string, fm = "") => {
    writeSkill(a.workspaceDir, name, { frontmatter: fm, files: { "notes/extra.md": "Extra.\n" } });
    const p = await loader.proposeWorkspaceApproval(name);
    await loader.install(p.id, await approve(a.broker, a.clock, p));
  };
  await approveWorkspace("tidy");
  return { ...a, loader, psycheHome, events, approveWorkspace };
}

function importer(extra: Parameters<ReturnType<typeof setup>["make"]>[0] = {}) {
  const b = setup();
  const psycheHome = join(b.base, "home");
  return { ...b, psycheHome, loader: b.make({ psycheHome, ...extra }) };
}

describe("M1: a bundle never installs as local", () => {
  it("re-importing the owner's own signed bundle is `verified`, not `local`", async () => {
    const o = await owner();
    const { bundle } = exportOf(o.loader, "tidy", "Ada");
    const p = await o.loader.proposeImport("t.psyche-skill", bundle);
    expect(p.bundle?.signer.status).toBe("own");
    expect(p.trust).toBe("verified");
    await o.loader.install(p.id, await approve(o.broker, o.clock, p));
    const home = (await o.loader.listDetailed()).find(
      (s) => s.name === "tidy" && s.source === "home",
    );
    expect(home?.trust).toBe("verified");
    // Third-party text for the model, as before: only bundled and local skills are trusted.
    expect(provenanceOfTrust(home?.trust ?? "unknown")).toBe("untrusted");
  });

  it("agent-written text stays `unknown` and `author: agent`, across export and import, whoever signs", async () => {
    const o = await owner();
    await o.loader.installAgentTree({
      name: "agent-made",
      tree: treeOf({ "SKILL.md": SKILL("agent-made") }),
      approvalId: await agentApproval(o),
      update: false,
    });
    const { bundle } = exportOf(o.loader, "agent-made", "Ada");
    expect(parse(bundle).manifest.origin).toBe("agent");
    // Even trusted and own, an agent-origin bundle installs as unknown.
    const mine = await o.loader.proposeImport("a.psyche-skill", bundle);
    expect(mine.bundle?.signer.status).toBe("own");
    expect(mine.trust).toBe("unknown");
    expect(mine.author).toBe("agent");
    const i = importer();
    const theirs = await i.loader.proposeImport("a.psyche-skill", bundle, { trustAuthor: true });
    expect(theirs.trust).toBe("unknown");
    await i.loader.install(theirs.id, await approve(i.broker, i.clock, theirs));
    const d = (await i.loader.listDetailed()).find((s) => s.name === "agent-made");
    expect(d?.trust).toBe("unknown");
    expect(d?.madeBy).toBe("agent");
    expect(i.loader.authors().authors[0]?.state).toBe("trusted");
  });

  it("the origin is signed: changing it breaks the signature", async () => {
    const o = await owner();
    await o.loader.installAgentTree({
      name: "agent-made",
      tree: treeOf({ "SKILL.md": SKILL("agent-made") }),
      approvalId: await agentApproval(o),
      update: false,
    });
    const b = parse(exportOf(o.loader, "agent-made", "Ada").bundle);
    b.manifest.origin = "workspace";
    expect(() => verifyBundle(JSON.stringify(b))).toThrow(/signature does not verify/);
    b.manifest.origin = "root";
    expect(() => verifyBundle(JSON.stringify(b))).toThrow(/origin must be/);
  });

  it("a home skill whose lock entry says `local` loads as `unknown`", async () => {
    const i = importer();
    const p = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple(), authorKey("Ada"), NOW),
    );
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    const lock = readLock(i.loader.lockPath);
    const entry = lock.skills["home:tidy"];
    if (entry === undefined) throw new Error("no entry");
    entry.trust = "local";
    writeLock(i.loader.lockPath, lock);
    expect((await i.loader.listDetailed()).find((s) => s.name === "tidy")?.trust).toBe("unknown");
  });

  it("an agent-made skill can be exported only from the Mac that made it", async () => {
    const o = await owner();
    await o.loader.installAgentTree({
      name: "agent-made",
      tree: treeOf({ "SKILL.md": SKILL("agent-made") }),
      approvalId: await agentApproval(o),
      update: false,
    });
    const { bundle } = exportOf(o.loader, "agent-made", "Ada");
    const i = importer();
    const p = await i.loader.proposeImport("a.psyche-skill", bundle);
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    // It carries `author: agent` there, but it was imported: the importer's key must not sign it.
    expect((await rejects(async () => i.loader.previewExport("agent-made"))).code).toBe("conflict");
  });
});

describe("M2: export is gated, host-only, audited and signs the origin", () => {
  const gates = (log: unknown[], fail = false): SkillsGates => ({
    export: async (_call, a, id) => {
      log.push({ ...a, id });
      if (fail) throw new PsycheError("approval_required", "needs approval");
    },
  });

  it("without a gate, exporting is refused and no key is made", async () => {
    const o = await owner();
    const h = createSkillsHandlers(o.loader, { broker: o.broker });
    expect((await rejects(h["skills.export"]({ name: "tidy", authorName: "Ada" }))).code).toBe(
      "unavailable",
    );
    expect(existsSync(join(o.psycheHome, "identity", "author.key"))).toBe(false);
  });

  it("the gate sees the name, tree hash, files and origin; a refusal signs nothing", async () => {
    const o = await owner();
    const log: unknown[] = [];
    const h = createSkillsHandlers(o.loader, { broker: o.broker, gates: gates(log, true) });
    const err = await rejects(h["skills.export"]({ name: "tidy", authorName: "Ada" }));
    expect(err.code).toBe("approval_required");
    expect(log[0]).toMatchObject({
      name: "tidy",
      origin: "workspace",
      treeHash: o.loader.previewExport("tidy").treeHash,
      files: [
        { path: "SKILL.md", executable: false },
        { path: "notes/extra.md", executable: false },
      ],
    });
    expect(existsSync(join(o.psycheHome, "identity", "author.key"))).toBe(false);
    expect(o.events).toEqual([]);
  });

  it("an approved export signs, and every export is audited with key, skill and tree hash", async () => {
    const o = await owner();
    const log: unknown[] = [];
    const h = createSkillsHandlers(o.loader, { broker: o.broker, gates: gates(log) });
    const r = await h["skills.export"]({ name: "tidy", authorName: "Ada", approvalId: "apr_1" });
    expect(parse(r.bundle).manifest.origin).toBe("workspace");
    expect(log[0]).toMatchObject({ id: "apr_1" });
    await h["skills.export"]({ name: "tidy" });
    const hash = o.loader.previewExport("tidy").treeHash;
    const exports = o.events.filter((e) => e.kind === "skill_exported");
    expect(exports).toHaveLength(2);
    expect(exports[0]).toMatchObject({ keyId: r.signer.keyId, skill: "tidy", treeHash: hash });
    expect(o.events.filter((e) => e.kind === "author_key_created")).toHaveLength(1);
  });

  it("files that changed after the card was approved are refused", async () => {
    const o = await owner();
    const pre = o.loader.previewExport("tidy");
    writeFileSync(join(o.workspaceDir, "tidy", "notes", "extra.md"), "changed after approval\n");
    // The approved hash no longer matches what the lock holds, and the lock was not updated.
    expect(() => o.loader.exportSkill("tidy", "Ada", pre.treeHash)).toThrow(PsycheError);
    expect(existsSync(join(o.psycheHome, "identity", "author.key"))).toBe(false);
  });

  it("the first export must name its author: no default, nothing made when it is missing", async () => {
    const o = await owner();
    const log: unknown[] = [];
    const h = createSkillsHandlers(o.loader, { broker: o.broker, gates: gates(log) });
    expect((await rejects(h["skills.export"]({ name: "tidy" }))).code).toBe("invalid_params");
    expect(log).toEqual([]);
    expect(() =>
      o.loader.exportSkill("tidy", undefined, o.loader.previewExport("tidy").treeHash),
    ).toThrow(/name to sign/);
    expect(() =>
      o.loader.exportSkill("tidy", "  ", o.loader.previewExport("tidy").treeHash),
    ).toThrow(/name to sign/);
    expect(existsSync(join(o.psycheHome, "identity", "author.key"))).toBe(false);
  });
});

describe("M3: loosening trust needs presence, and trustAuthor is bound to the card", () => {
  async function seen() {
    const o = await owner();
    const { bundle, signer } = exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const p = await i.loader.proposeImport("t.psyche-skill", bundle);
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    return { i, bundle, keyId: signer.keyId };
  }

  it("trusting, and leaving revoked, go through the gate; un-trusting and revoking do not", async () => {
    const { i, keyId } = await seen();
    const calls: { from: string | undefined; to: string }[] = [];
    const gates: SkillsGates = {
      authorChange: async (_c, a) => {
        calls.push({ from: a.from, to: a.to });
      },
    };
    const h = createSkillsHandlers(i.loader, { broker: i.broker, gates });
    await h["skills.authors.set"]({ keyId, state: "trusted" });
    expect(calls).toEqual([{ from: "seen", to: "trusted" }]);
    await h["skills.authors.set"]({ keyId, state: "seen" }); // tightening
    await h["skills.authors.set"]({ keyId, state: "revoked" }); // tightening
    expect(calls).toHaveLength(1);
    await h["skills.authors.set"]({ keyId, state: "seen" }); // out of revoked: loosening
    expect(calls).toEqual([
      { from: "seen", to: "trusted" },
      { from: "revoked", to: "seen" },
    ]);
  });

  it("a refused gate changes nothing; with no gate at all loosening is unavailable", async () => {
    const { i, keyId } = await seen();
    const deny: SkillsGates = {
      authorChange: async () => {
        throw new PsycheError("approval_required", "needs presence");
      },
    };
    const h = createSkillsHandlers(i.loader, { broker: i.broker, gates: deny });
    await rejects(h["skills.authors.set"]({ keyId, state: "trusted" }));
    expect(i.loader.authorState(keyId)).toBe("seen");
    const bare = createSkillsHandlers(i.loader, { broker: i.broker });
    expect((await rejects(bare["skills.authors.set"]({ keyId, state: "trusted" }))).code).toBe(
      "unavailable",
    );
    // Revoking never needs a gate.
    await bare["skills.authors.set"]({ keyId, state: "revoked" });
    expect(i.loader.authorState(keyId)).toBe("revoked");
    expect((await rejects(bare["skills.authors.set"]({ keyId, state: "seen" }))).code).toBe(
      "unavailable",
    );
  });

  it("trustAuthor is part of the binding and the card: the other card cannot install it", async () => {
    const o = await owner();
    const { bundle } = exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const h = createSkillsHandlers(i.loader, { broker: i.broker });
    const plain = await h["skills.proposeImport"]({ name: "t.psyche-skill", text: bundle });
    const trusting = await h["skills.proposeImport"]({
      name: "t.psyche-skill",
      text: bundle,
      trustAuthor: true,
    });
    expect(plain.proposal.bindingHash).not.toBe(trusting.proposal.bindingHash);
    expect(trusting.approval.details).toMatchObject({ trustAuthor: true });
    expect(trusting.approval.summary).toContain("also trusts this author");
    expect(plain.approval.details).not.toHaveProperty("trustAuthor");
    // The card the approver gave for "do not trust" does not install the trusting proposal.
    const plainCard = await approve(i.broker, i.clock, plain.proposal);
    expect((await rejects(i.loader.install(trusting.proposal.id, plainCard))).code).toBe(
      "binding_mismatch",
    );
    await i.loader.install(plain.proposal.id, plainCard);
    expect(i.loader.authors().authors[0]?.state).toBe("seen");
    // The trusting card does trust.
    const j = importer();
    const t2 = await j.loader.proposeImport("t.psyche-skill", bundle, { trustAuthor: true });
    await j.loader.install(t2.id, await approve(j.broker, j.clock, t2));
    expect(j.loader.authors().authors[0]?.state).toBe("trusted");
  });

  it("trustAuthor means nothing for an unsigned bundle, a trusted key or the owner's own", async () => {
    const i = importer();
    const u = await i.loader.proposeImport(
      "u.psyche-skill",
      buildBundle(simple(), undefined, NOW),
      {
        trustAuthor: true,
      },
    );
    expect(u.trustAuthor).toBeUndefined();
    const o = await owner();
    const own = await o.loader.proposeImport(
      "o.psyche-skill",
      exportOf(o.loader, "tidy", "Ada").bundle,
      {
        trustAuthor: true,
      },
    );
    expect(own.trustAuthor).toBeUndefined();
  });
});

describe("M4: the background role is part of what a skill asks for", () => {
  it("a wider role is a widening: tools, denials, mode, caps, approvals, plan-first, memory", () => {
    const base = {
      role: "researcher",
      label: "Researcher",
      model: "primary",
      maxMode: "balanced",
      tools: ["files.read"],
      deny: ["files.delete"],
      memory: "none",
      budget: { tokens: 1000 },
      caps: { maxHours: 2 },
      result: "findings",
      planFirst: true,
      approvals: [] as string[],
    };
    const m = (specialist?: typeof base) => ({
      tools: [],
      permissions: [],
      prompts: [],
      ...(specialist === undefined ? {} : { specialist }),
    });
    expect(widenedBy(m(base), m(base))).toBeUndefined();
    const wider = widenedBy(
      m(base),
      m({
        ...base,
        tools: ["files.read", "email.send"],
        deny: [],
        maxMode: "auto",
        caps: { maxHours: 20 },
        approvals: ["send_email"],
        planFirst: false,
        memory: "user" as never,
      }),
    );
    const text = (wider?.specialist ?? []).join(" | ");
    for (const part of [
      "email.send",
      "files.delete",
      "auto",
      "caps maxHours",
      "send_email",
      "plans first",
      "memory",
    ])
      expect(text).toContain(part);
    expect(widenedBy(m(), m(base))?.specialist?.[0]).toMatch(/adds the background role researcher/);
    // Narrower is quiet.
    expect(widenedBy(m(base), m({ ...base, tools: [], maxMode: "plan" }))).toBeUndefined();
  });

  it("an update that widens the role is flagged on the card, and a bundle that hides it is refused", async () => {
    const i = importer();
    const key = authorKey("Ada");
    const v1 = simple("research", ROLE("files.read"));
    const p1 = await i.loader.proposeImport("a.psyche-skill", buildBundle(v1, key, NOW));
    expect(p1.manifest.specialist?.role).toBe("researcher");
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    const v2 = simple("research", ROLE("files.read, email.send", "      maxMode: auto\n"));
    const p2 = await i.loader.proposeImport("b.psyche-skill", buildBundle(v2, key, NOW));
    expect(p2.update?.widened?.specialist?.join(" ")).toContain("email.send");
    expect(p2.findings.some((f) => f.rule === "permissions-widened")).toBe(true);
    const h = createSkillsHandlers(i.loader, { broker: i.broker });
    const staged = await h["skills.proposeImport"]({
      name: "b.psyche-skill",
      text: buildBundle(v2, key, NOW),
    });
    expect(staged.approval.details).toMatchObject({ widened: { specialist: expect.any(Array) } });
    // A signed lie: requests without the role while the frontmatter defines one.
    const lie = parse(buildBundle(v2, key, NOW));
    delete lie.manifest.requests.specialist;
    lie.signature = key.sign(signingBytes(lie.manifest));
    expect(() => verifyBundle(JSON.stringify(lie))).toThrow(/permissions the manifest declares/);
    // And one that understates the role.
    const small = parse(buildBundle(v2, key, NOW));
    small.manifest.requests.specialist.tools = ["files.read"];
    small.signature = key.sign(signingBytes(small.manifest));
    expect(() => verifyBundle(JSON.stringify(small))).toThrow(/permissions the manifest declares/);
  });

  it("the role is turned off again when its skill is installed, updated or removed", async () => {
    const resets: string[] = [];
    const i = importer({ onSpecialistReset: (role: string) => resets.push(role) });
    const key = authorKey("Ada");
    const p1 = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("research", ROLE("files.read")), key, NOW),
    );
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    expect(resets).toEqual(["researcher"]);
    const p2 = await i.loader.proposeImport(
      "b.psyche-skill",
      buildBundle(simple("research", ROLE("files.read", "      maxMode: auto\n")), key, NOW),
    );
    await i.loader.install(p2.id, await approve(i.broker, i.clock, p2));
    expect(resets).toEqual(["researcher", "researcher"]);
    await i.loader.remove("research");
    expect(resets).toHaveLength(3);
    // A skill with no role never resets one.
    const p3 = await i.loader.proposeImport(
      "c.psyche-skill",
      buildBundle(simple("plain"), key, NOW),
    );
    await i.loader.install(p3.id, await approve(i.broker, i.clock, p3));
    expect(resets).toHaveLength(3);
  });

  it("warns when a role id is already defined by another skill", async () => {
    const i = importer();
    const key = authorKey("Ada");
    const p1 = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("research", ROLE("files.read")), key, NOW),
    );
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    const p2 = await i.loader.proposeImport(
      "b.psyche-skill",
      buildBundle(simple("research-two", ROLE("files.read")), key, NOW),
    );
    const f = p2.findings.find((x) => x.rule === "role-shadow");
    expect(f?.severity).toBe("warn");
    expect(f?.message).toContain('"research"');
  });
});

describe("M5: author names are data, compared by skeleton", () => {
  it("quotes the name and puts the status first, so a name cannot pose as the summary", async () => {
    const i = importer();
    const evil = authorKey('Ada" (trusted; signed by "Owner');
    const h = createSkillsHandlers(i.loader, { broker: i.broker });
    const { approval } = await h["skills.proposeImport"]({
      name: "t.psyche-skill",
      text: buildBundle(simple(), evil, NOW),
    });
    expect(approval.summary.startsWith('Install skill "tidy" (new; signed by "')).toBe(true);
    // Only our own four quotes: the name's were replaced.
    expect(approval.summary.split('"').length - 1).toBe(4);
    expect(quoteForSummary('a‮"b\nc')).toBe('"a b c"');
    expect(quoteForSummary("x".repeat(100)).length).toBeLessThan(50);
  });

  it("names are compared as NFKC, case-folded, space-collapsed skeletons", () => {
    const base = authorNameSkeleton("Ada Lovelace");
    for (const v of [
      "ada   lovelace",
      "ＡＤＡ Lovelace",
      "Аdа Lovelace",
      "Ada L0velace",
      " Ada​ Lovelace ",
    ])
      expect(authorNameSkeleton(v), v).toBe(base);
    expect(authorNameSkeleton("Grace Hopper")).not.toBe(base);
  });

  it("a look-alike of the owner's own name with another key is impersonation, never trusted", async () => {
    const o = await owner();
    exportOf(o.loader, "tidy", "Ada Lovelace");
    const fake = authorKey("Аda Lovelace"); // a Cyrillic A
    const p = await o.loader.proposeImport(
      "x.psyche-skill",
      buildBundle(simple("other"), fake, NOW),
    );
    expect(p.bundle?.signer).toMatchObject({ status: "changed", impersonates: true });
    expect(p.trust).toBe("unknown");
    const f = p.findings.find((x) => x.rule === "signer-changed");
    expect(f?.message).toContain("matches your own author name");
    const h = createSkillsHandlers(o.loader, { broker: o.broker });
    const { approval } = await h["skills.proposeImport"]({
      name: "x.psyche-skill",
      text: buildBundle(simple("other"), fake, NOW),
    });
    expect(approval.summary).toContain("name matches yours, key does not");
    // Even if the owner trusted that key, it stays flagged: it is still a changed key.
    o.loader.setAuthorState(p.bundle?.signer.keyId as string, "revoked");
    expect(
      (
        await rejects(
          o.loader.proposeImport("x.psyche-skill", buildBundle(simple("other"), fake, NOW)),
        )
      ).code,
    ).toBe("policy_denied");
  });

  it("a look-alike of a name seen under another key is `changed`", async () => {
    const i = importer();
    const real = authorKey("Grace Hopper");
    const p1 = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("one"), real, NOW),
    );
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    const fake = authorKey("Grace  H0pper");
    const p2 = await i.loader.proposeImport(
      "b.psyche-skill",
      buildBundle(simple("two"), fake, NOW),
    );
    expect(p2.bundle?.signer.status).toBe("changed");
  });

  it("a trusted key signing under a name it has not used is flagged, a re-spelling of the same name is not", async () => {
    const i = importer();
    const key = authorKey("Ada");
    const p1 = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("one"), key, NOW),
      { trustAuthor: true },
    );
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    const same = await i.loader.proposeImport(
      "b.psyche-skill",
      buildBundle(simple("two"), renamed(key, "  ADA "), NOW),
    );
    expect(same.bundle?.signer.status).toBe("trusted");
    expect(same.bundle?.signer.nameChanged).toBeUndefined();
    const drift = await i.loader.proposeImport(
      "c.psyche-skill",
      buildBundle(simple("three"), renamed(key, "Ada Lovelace-Byron"), NOW),
    );
    expect(drift.bundle?.signer).toMatchObject({ status: "trusted", nameChanged: true });
    expect(drift.findings.some((f) => f.rule === "signer-name-changed")).toBe(true);
  });
});

describe("L1 and L2: signer changes for every source, and rollback", () => {
  it("a signed install replaced from a folder is flagged like any other signer change", async () => {
    const i = importer();
    const p1 = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("tidy"), authorKey("Ada"), NOW),
    );
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    const src = writeSkill(tempDir(), "tidy", { body: "# Different\n" });
    const p2 = await i.loader.proposeInstall({ kind: "path", path: src });
    expect(p2.update?.signerChanged).toBe(true);
    expect(p2.findings.some((f) => f.rule === "signer-changed" && f.severity === "warn")).toBe(
      true,
    );
    // An unsigned install replaced by a folder is not a signer change.
    const q = importer();
    const u = await q.loader.proposeImport(
      "u.psyche-skill",
      buildBundle(simple("tidy"), undefined, NOW),
    );
    await q.loader.install(u.id, await approve(q.broker, q.clock, u));
    const same = await q.loader.proposeInstall({ kind: "path", path: src });
    expect(same.update?.signerChanged).toBeUndefined();
  });

  it("an older bundle offered over a newer install is flagged as a possible rollback", async () => {
    const i = importer();
    const key = authorKey("Ada");
    const p1 = await i.loader.proposeImport(
      "new.psyche-skill",
      buildBundle(simple("tidy"), key, NOW),
    );
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    expect(readLock(i.loader.lockPath).skills["home:tidy"]?.bundleCreatedAt).toBe(
      NOW.toISOString(),
    );
    const older = buildBundle(
      simple("tidy", "", "Older.\n"),
      key,
      new Date("2026-10-01T00:00:00Z"),
    );
    const p2 = await i.loader.proposeImport("old.psyche-skill", older);
    expect(
      p2.findings.some((f) => f.rule === "older-than-installed" && f.severity === "warn"),
    ).toBe(true);
    const newer = buildBundle(
      simple("tidy", "", "Newer.\n"),
      key,
      new Date("2026-11-05T00:00:00Z"),
    );
    const p3 = await i.loader.proposeImport("newer.psyche-skill", newer);
    expect(p3.findings.some((f) => f.rule === "older-than-installed")).toBe(false);
  });
});

describe("L3: links are resolved, pinned and answer generically", () => {
  const good = () => buildBundle(simple("tidy"), authorKey("Ada"), NOW);
  const reply = (body: string, init: ResponseInit = {}) =>
    new Response(body, { status: 200, ...init });
  const publicDns = async () => ["93.184.216.34"];

  it("accepts only https URLs on public host names, with or without a trailing dot", () => {
    expect(() => checkBundleUrl("http://example.com/a")).toThrow(/https/);
    expect(() => checkBundleUrl("https://user:pw@example.com/a")).toThrow(/credentials/);
    for (const u of [
      "https://localhost/a",
      "https://localhost./a",
      "https://LOCALHOST../a",
      "https://127.0.0.1/a",
      "https://127.0.0.1./a",
      "https://10.0.0.5/a",
      "https://[::1]/a",
      "https://[::ffff:10.0.0.1]/a",
      "https://nas.local./a",
      "https://intranet/a",
      "https://x.internal/a",
      "https://2130706433/a",
      "https://0x7f000001/a",
    ])
      expect(() => checkBundleUrl(u), u).toThrow(PsycheError);
    expect(checkBundleUrl("https://example.com./a").hostname).toBe("example.com.");
  });

  it("knows which addresses are not public", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::1",
      "ff02::1",
      "::ffff:192.168.0.1",
      "64:ff9b::1",
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  it("a name that resolves to a private address is refused before any connection", async () => {
    let connected = 0;
    const fetchImpl = async () => {
      connected += 1;
      return reply(good());
    };
    for (const ip of [
      "10.0.0.5",
      "127.0.0.1",
      "::1",
      "169.254.169.254",
      "fd00::1",
      "::ffff:10.0.0.1",
      "100.64.0.1",
    ]) {
      const err = await rejects(
        fetchBundleText("https://evil.example.com/a", { fetchImpl, resolveHost: async () => [ip] }),
      );
      expect(err.message).toMatch(/not allowed/);
    }
    // One bad address among good ones is enough.
    await rejects(
      fetchBundleText("https://evil.example.com/a", {
        fetchImpl,
        resolveHost: async () => ["93.184.216.34", "10.0.0.1"],
      }),
    );
    expect(connected).toBe(0);
  });

  it("connects to the address that passed the check, and re-resolves on every redirect hop", async () => {
    const pinned: string[] = [];
    const resolved: string[] = [];
    const fetchImpl = async (url: string, _init: RequestInit, address: string) => {
      pinned.push(`${new URL(url).hostname}@${address}`);
      if (url.endsWith("/a"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.org/b" },
        });
      return reply(good());
    };
    const resolveHost = async (host: string) => {
      resolved.push(host);
      return host === "example.com" ? ["93.184.216.34", "93.184.216.35"] : ["203.0.113.9"];
    };
    expect(await fetchBundleText("https://example.com/a", { fetchImpl, resolveHost })).toContain(
      "psyche-bundle",
    );
    expect(pinned).toEqual(["example.com@93.184.216.34", "cdn.example.org@203.0.113.9"]);
    expect(resolved).toEqual(["example.com", "cdn.example.org"]);
    // A redirect to a host that resolves privately dies on that hop.
    const rebind = async (host: string) =>
      host === "example.com" ? ["93.184.216.34"] : ["192.168.1.10"];
    await rejects(fetchBundleText("https://example.com/a", { fetchImpl, resolveHost: rebind }));
  });

  it("every network failure reads the same: no oracle for what is on the owner's network", async () => {
    const messages = new Set<string>();
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        fetchBundleText("https://a.example.com/x", {
          resolveHost: async () => {
            throw new Error("ENOTFOUND secret.internal");
          },
        }),
      () =>
        fetchBundleText("https://a.example.com/x", {
          resolveHost: publicDns,
          fetchImpl: async () => {
            throw new Error("ECONNREFUSED 10.0.0.9:22");
          },
        }),
      () =>
        fetchBundleText("https://a.example.com/x", {
          resolveHost: publicDns,
          fetchImpl: async () => new Response("no", { status: 404 }),
        }),
      () =>
        fetchBundleText("https://a.example.com/x", {
          resolveHost: publicDns,
          fetchImpl: async () => new Response("no", { status: 500 }),
        }),
      () =>
        fetchBundleText("https://a.example.com/x", {
          resolveHost: publicDns,
          fetchImpl: async () => new Response(null, { status: 302 }),
        }),
    ];
    for (const attempt of attempts) {
      const e = await rejects(attempt());
      messages.add(`${e.code}:${e.message}`);
      expect(e.message).not.toMatch(/ENOTFOUND|ECONNREFUSED|10\.0\.0|404|500|secret/);
    }
    expect(messages.size).toBe(1);
  });

  it("downloads, verifies and stages; follows https redirects, refuses http, caps the size", async () => {
    const t = setup({
      sourceOptions: { fetchImpl: async () => reply(good()), resolveHost: publicDns },
    });
    const p = await t.loader.proposeInstall({
      kind: "bundleUrl",
      url: "https://example.com/t.psyche-skill",
    });
    expect(p.source).toEqual({ kind: "bundleUrl", url: "https://example.com/t.psyche-skill" });
    await t.loader.install(p.id, await approve(t.broker, t.clock, p));
    expect((await t.loader.checkUpdates("tidy"))[0]).toMatchObject({ updateAvailable: false });
    const toHttp = async () =>
      new Response(null, { status: 302, headers: { location: "http://example.com/c" } });
    expect(
      (
        await rejects(
          fetchBundleText("https://example.com/a", { fetchImpl: toHttp, resolveHost: publicDns }),
        )
      ).message,
    ).toMatch(/not allowed/);
    const loop = async () => new Response(null, { status: 302, headers: { location: "/again" } });
    await rejects(
      fetchBundleText("https://example.com/a", { fetchImpl: loop, resolveHost: publicDns }),
    );
    const byHeader = async () =>
      reply("{}", { headers: { "content-length": String(MAX_BUNDLE_BYTES + 1) } });
    expect(
      (
        await rejects(
          fetchBundleText("https://example.com/a", { fetchImpl: byHeader, resolveHost: publicDns }),
        )
      ).message,
    ).toMatch(/larger than/);
    const seen: RequestInit[] = [];
    const byStream = async (_u: string, init: RequestInit) => {
      seen.push(init);
      return reply("x".repeat(MAX_BUNDLE_BYTES + 10));
    };
    expect(
      (
        await rejects(
          fetchBundleText("https://example.com/a", { fetchImpl: byStream, resolveHost: publicDns }),
        )
      ).message,
    ).toMatch(/larger than/);
    expect(seen[0]?.credentials).toBe("omit");
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("a file import cannot be fetched, and its updates are re-imports", async () => {
    const t = setup();
    await rejects(t.loader.proposeInstall({ kind: "bundleFile", name: "x" }));
    const p = await t.loader.proposeImport("t.psyche-skill", good());
    await t.loader.install(p.id, await approve(t.broker, t.clock, p));
    expect((await rejects(t.loader.proposeUpdate("tidy"))).message).toMatch(/import the new file/);
    expect(await t.loader.checkUpdates()).toEqual([]);
  });
});

describe("L4: full case and form folding on every path prefix", () => {
  it("finds collisions through folder prefixes, ligatures, sharp s and a file/folder clash", () => {
    expect(foldConflict(["a/x.md", "b/y.md"])).toBeUndefined();
    expect(foldConflict(["Docs/a.md", "docs/b.md"])).toBeDefined();
    expect(foldConflict(["a", "A/b"])).toBeDefined();
    expect(foldConflict(["a", "a/b"])).toBeDefined();
    expect(foldConflict(["STRASSE/x", "straße/y"])).toBeDefined();
    expect(foldConflict(["ﬁle.md", "file.md"])).toBeDefined();
    expect(foldConflict(["é.md", "é.md"])).toBeDefined();
    expect(foldConflict(["same.md", "same.md"])).toBeDefined();
  });

  it("a bundle with such paths is refused, and so is the same set from a folder import", async () => {
    const tree = treeOf({ "SKILL.md": SKILL("tidy"), "Docs/a.md": "A\n", "docs/b.md": "B\n" });
    expect(() => verifyBundle(buildBundle(tree, undefined, NOW))).toThrow(
      /differ only in case or form/,
    );
    const t = setup();
    const staged = t.loader as unknown as { proposeImport(n: string, x: string): Promise<unknown> };
    await rejects(staged.proposeImport("x", buildBundle(tree, undefined, NOW)));
  });

  it("a failed write leaves no staging folder behind", () => {
    const root = tempDir();
    const tree = new Map([
      ["a", { bytes: enc("file"), executable: false }],
      ["a/b", { bytes: enc("under a file"), executable: false }],
    ]) as SkillTree;
    expect(() => writeTree(root, join(root, "tidy"), tree)).toThrow();
    expect(existsSync(join(root, "tidy"))).toBe(false);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });
});

describe("L5 and L6: fail closed, and bounded staging", () => {
  it("an unreadable author list blocks what a signed skill, and never reads as `not revoked`", async () => {
    const i = importer();
    const p = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple(), authorKey("Ada"), NOW),
    );
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    expect((await i.loader.listDetailed()).find((s) => s.name === "tidy")?.status).toBe("active");
    writeFileSync(join(i.homeDir, "authors.json"), "{ not json");
    const d = (await i.loader.listDetailed()).find((s) => s.name === "tidy");
    expect(d?.status).toBe("blocked");
    expect(d?.reasons.join()).toContain("cannot be read");
    expect(d?.enabled).toBe(false);
    await rejects(
      i.loader.proposeImport("b.psyche-skill", buildBundle(simple(), authorKey("Bo"), NOW)),
    );
  });

  it("staged proposals are capped, and expired ones are swept", async () => {
    const i = importer();
    const text = buildBundle(simple(), undefined, NOW);
    const first = await i.loader.proposeImport("0.psyche-skill", text);
    for (let n = 1; n < 70; n += 1) await i.loader.proposeImport(`${n}.psyche-skill`, text);
    expect(i.loader.getProposal(first.id)).toBeUndefined();
    const last = await i.loader.proposeImport("last.psyche-skill", text);
    expect(i.loader.getProposal(last.id)).toBeDefined();
    const t = setup({ proposalTtlMs: 1000 });
    const old = await t.loader.proposeImport("old.psyche-skill", text);
    t.clock.advance(5000);
    await t.loader.proposeImport("new.psyche-skill", text);
    expect(t.loader.getProposal(old.id)).toBeUndefined();
  });
});

describe("L7: the author key file is read without links and with the right mode", () => {
  it("refuses a link, a loose mode, and a non-key; reads a good one", () => {
    const home = tempDir();
    const store = new AuthorKeyStore(home);
    expect(store.peek()).toBeUndefined();
    const { signer } = store.loadOrCreate("Ada");
    expect(store.peek()?.keyId).toBe(signer.author.keyId);
    const path = join(home, "identity", "author.key");
    chmodSync(path, 0o644);
    expect(() => store.peek()).toThrow(/readable by others/);
    chmodSync(path, 0o600);
    expect(store.peek()?.name).toBe("Ada");
    // A link in its place, even one to a good key.
    const real = join(home, "identity", "real.key");
    writeFileSync(real, readFileSync(path), { mode: 0o600 });
    rmSync(path);
    symlinkSync(real, path);
    expect(() => store.peek()).toThrow(/link/);
    expect(() => store.loadOrCreate("Eve")).toThrow(/link/);
    rmSync(path);
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(() => store.peek()).toThrow(/not an author key/);
  });

  it("temp files are created exclusively: a planted link is replaced, never written through", () => {
    const dir = tempDir();
    const ring = new AuthorRing(dir);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    mkdirSync(dir, { recursive: true });
    symlinkSync(victim, join(dir, `authors.json.${process.pid}.tmp`));
    const key = authorKey("Ada").author;
    ring.observe(key);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(ring.get(key.keyId)?.state).toBe("seen");
    expect(existsSync(join(dir, `authors.json.${process.pid}.tmp`))).toBe(false);
  });
});

describe("L8: keys, signatures and data have one spelling", () => {
  /** Another base64url string for the same bytes: the last character's spare bits differ. */
  function respell(s: string): string {
    const bytes = Buffer.from(s, "base64url");
    const head = s.slice(0, -1);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const c of alphabet) {
      const alt = head + c;
      if (alt !== s && Buffer.from(alt, "base64url").equals(bytes)) return alt;
    }
    throw new Error("no alternative spelling");
  }

  it("refuses a signature or key written another way", () => {
    const key = authorKey("Ada");
    const good = parse(buildBundle(simple(), key, NOW));
    const sig = parse(JSON.stringify(good));
    sig.signature = respell(sig.signature);
    expect(() => verifyBundle(JSON.stringify(sig))).toThrow(/malformed signature/);
    const pub = parse(JSON.stringify(good));
    pub.manifest.author.publicKey = respell(pub.manifest.author.publicKey);
    expect(() => verifyBundle(JSON.stringify(pub))).toThrow(/malformed public key/);
    expect(() => verifyBundle(JSON.stringify(good))).not.toThrow();
  });

  it("refuses payload data that is not the canonical base64 of its bytes", () => {
    const b = parse(buildBundle(simple(), undefined, NOW));
    const entry = b.files.find((f: { path: string }) => f.path === "notes/extra.md");
    const std = entry.data as string; // 'Extra.\n' is 7 bytes: two '=' pads
    const bytes = Buffer.from(std, "base64");
    const head = std.replace(/=+$/, "");
    const pads = std.slice(head.length);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let alt: string | undefined;
    for (const c of alphabet) {
      const cand = head.slice(0, -1) + c + pads;
      if (cand !== std && Buffer.from(cand, "base64").equals(bytes)) alt = cand;
    }
    if (alt === undefined) throw new Error("no alternative spelling");
    entry.data = alt;
    expect(() => verifyBundle(JSON.stringify(b))).toThrow(/canonical base64/);
  });

  it("canonical JSON accepts finite numbers (role budgets) and nothing else odd", () => {
    expect(canonicalJson({ costUsd: 1.5, n: 2 })).toBe('{"costUsd":1.5,"n":2}');
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow();
  });
});
