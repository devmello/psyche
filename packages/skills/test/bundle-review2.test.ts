import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { exposeToOthers } from "@psyche/hostfs/testing";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { authorNameSkeleton } from "../src/authors.ts";
import { buildBundle } from "../src/bundle.ts";
import { fetchBundleText, isPrivateAddress } from "../src/bundle-url.ts";
import { createSkillsHandlers, quoteForSummary, type SkillsGates } from "../src/handlers.ts";
import { writeTree } from "../src/loader.ts";
import { widenedBy } from "../src/widen.ts";
import {
  authorKey,
  exportOf,
  importer,
  NOW,
  owner,
  rejects,
  simple,
  treeOf,
} from "./bundle-kit.ts";
import { approve, tempDir } from "./helpers.ts";

/** The second independent review: trust on the install card, key file, audit, limits, forms. */

describe("trust on the install card", () => {
  it("trustAuthor is refused for a look-alike of the owner's own author name", async () => {
    const o = await owner();
    await exportOf(o.loader, "tidy", "Ada Lovelace");
    const text = buildBundle(simple("other"), authorKey("Аda Lovelace"), NOW); // Cyrillic A
    expect(
      (await rejects(o.loader.proposeImport("x.psyche-skill", text, { trustAuthor: true }))).code,
    ).toBe("policy_denied");
    const p = await o.loader.proposeImport("x.psyche-skill", text);
    expect(p.bundle?.signer.impersonates).toBe(true);
    expect(p.trustAuthor).toBeUndefined();
  });

  it("installing a proposal that also trusts its author goes through the trust gate first", async () => {
    const o = await owner();
    const { bundle, signer } = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const calls: { to: string; via?: string; from?: string }[] = [];
    let fail = true;
    const gates: SkillsGates = {
      authorChange: async (_c, a, id) => {
        calls.push({ to: a.to, ...(a.via === undefined ? {} : { via: a.via }), from: a.from });
        if (fail && id === undefined) throw new PsycheError("approval_required", "needs presence");
      },
    };
    const h = createSkillsHandlers(i.loader, { broker: i.broker, gates });
    const { proposal } = await h["skills.proposeImport"]({
      name: "t.psyche-skill",
      text: bundle,
      trustAuthor: true,
    });
    const card = await approve(i.broker, i.clock, proposal);
    expect(
      (await rejects(h["skills.install"]({ proposalId: proposal.id, approvalId: card }))).code,
    ).toBe("approval_required");
    expect(existsSync(join(i.homeDir, "tidy"))).toBe(false);
    expect(i.loader.authorState(signer.keyId)).toBeUndefined();
    expect(calls).toEqual([{ to: "trusted", via: "install", from: undefined }]);
    fail = false;
    await h["skills.install"]({
      proposalId: proposal.id,
      approvalId: card,
      trustApprovalId: "apr_presence",
    });
    expect(i.loader.authorState(signer.keyId)).toBe("trusted");
  });

  it("a proposal that does not trust its author never touches the gate; with no gate, one that does is refused", async () => {
    const o = await owner();
    const { bundle } = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const calls: unknown[] = [];
    const h = createSkillsHandlers(i.loader, {
      broker: i.broker,
      gates: { authorChange: async (...a) => void calls.push(a) },
    });
    const { proposal } = await h["skills.proposeImport"]({ name: "t.psyche-skill", text: bundle });
    await h["skills.install"]({
      proposalId: proposal.id,
      approvalId: await approve(i.broker, i.clock, proposal),
    });
    expect(calls).toEqual([]);
    const j = importer();
    const bare = createSkillsHandlers(j.loader, { broker: j.broker });
    const { proposal: p2 } = await bare["skills.proposeImport"]({
      name: "t.psyche-skill",
      text: bundle,
      trustAuthor: true,
    });
    const card = await approve(j.broker, j.clock, p2);
    expect(
      (await rejects(bare["skills.install"]({ proposalId: p2.id, approvalId: card }))).code,
    ).toBe("unavailable");
  });
});

describe("the author key file and the export audit", () => {
  it("an unsafe key file gives a clear error for a signed import and blocks nothing else", async () => {
    const o = await owner();
    const p0 = await o.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("other"), authorKey("Bo"), NOW),
    );
    await o.loader.install(p0.id, await approve(o.broker, o.clock, p0));
    await exportOf(o.loader, "tidy", "Ada");
    exposeToOthers(join(o.psycheHome, "identity", "author.key"));
    const err = await rejects(
      o.loader.proposeImport("b.psyche-skill", buildBundle(simple("third"), authorKey("Cy"), NOW)),
    );
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/author key file has unsafe permissions/);
    await o.loader.proposeImport("c.psyche-skill", buildBundle(simple("third"), undefined, NOW));
    expect(() => o.loader.authors()).not.toThrow();
    expect((await o.loader.listDetailed()).find((x) => x.name === "other")?.status).toBe("active");
    const e2 = await rejects(
      o.loader.exportSkill("tidy", "Ada", o.loader.previewExport("tidy").treeHash),
    );
    expect(e2.code).toBe("conflict");
  });

  it("an export whose audit entry cannot be written is not returned", async () => {
    const o = await owner({
      onAuthorChange: async (e: { kind: string }) => {
        if (e.kind === "skill_exported") throw new Error("audit disk full");
      },
    });
    await expect(
      o.loader.exportSkill("tidy", "Ada", o.loader.previewExport("tidy").treeHash),
    ).rejects.toThrow(/audit disk full/);
    // Other author events never fail the action they describe.
    const i = importer({
      onAuthorChange: async () => {
        throw new Error("audit disk full");
      },
    });
    const p = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("x"), authorKey("Bo"), NOW),
      { trustAuthor: true },
    );
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    expect(i.loader.authors().authors[0]?.state).toBe("trusted");
  });

  it("the audit entry is written before the signature is returned", async () => {
    const order: string[] = [];
    const o = await owner({
      onAuthorChange: async (e: { kind: string }) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(e.kind);
      },
    });
    const r = await o.loader.exportSkill("tidy", "Ada", o.loader.previewExport("tidy").treeHash);
    order.push("returned");
    expect(order).toEqual(["author_key_created", "skill_exported", "returned"]);
    expect(r.bundle).toContain("psyche-bundle");
  });
});

describe("widening, writes, addresses, quotes and skeletons", () => {
  const base = {
    role: "researcher",
    label: "Researcher",
    model: "primary",
    maxMode: "balanced",
    tools: ["files.read"],
    deny: [] as string[],
    memory: "none",
    budget: { tokens: 1000 } as Record<string, number>,
    caps: { maxHours: 2, tokens: 5000 } as Record<string, number>,
    result: "findings",
    planFirst: true,
    approvals: [] as string[],
  };
  const m = (specialist: typeof base) => ({ tools: [], permissions: [], prompts: [], specialist });

  it("a limit that disappears is wider, one that appears is narrower, and the result kind is compared", () => {
    const text = (next: typeof base) => widenedBy(m(base), m(next))?.specialist?.join(" | ");
    expect(text({ ...base, caps: { maxHours: 2 } })).toContain("caps tokens limit is removed");
    expect(text({ ...base, budget: {} })).toContain("budget tokens limit is removed");
    expect(text({ ...base, caps: { maxHours: 3, tokens: 5000 } })).toContain("caps maxHours grows");
    expect(text({ ...base, result: "changes" })).toContain("result kind changes from findings");
    expect(text({ ...base, budget: { tokens: 1000, minutes: 5 } })).toBeUndefined();
    expect(text({ ...base, caps: { maxHours: 1, tokens: 100 } })).toBeUndefined();
  });

  it("writeTree puts the installed tree back when the final rename fails", () => {
    const root = tempDir();
    const target = join(root, "tidy");
    writeTree(root, target, treeOf({ "SKILL.md": "old\n" }));
    let n = 0;
    const flaky = (from: string, to: string) => {
      n += 1;
      if (n === 2) throw new Error("rename failed"); // staging -> target
      renameSync(from, to);
    };
    expect(() => writeTree(root, target, treeOf({ "SKILL.md": "new\n" }), flaky)).toThrow(
      /rename failed/,
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old\n");
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  it("knows the harder IPv6 and IPv4 forms", () => {
    const blocked = [
      "::1.2.3.4",
      "::10.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:0a00:0001",
      "0:0:0:0:0:ffff:10.0.0.1",
      "::FFFF:A00:1",
      "::ffff:0:10.0.0.1",
      "2002:0a00:0001::1",
      "2002::1",
      "fec0::1",
      "feb0::1",
      "fe80::1%eth0",
      "2001:db8::1",
      "2001::1",
      "100::1",
      "192.0.2.1",
      "198.51.100.7",
      "203.0.113.9",
      "192.88.99.1",
      "255.255.255.255",
      "010.0.0.1",
      "127.1",
      "0x7f.0.0.1",
      "2130706433",
      "::ffff:127.0.0.1",
      "[::1]",
      "",
      "not an address",
    ];
    for (const a of blocked) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of [
      "93.184.216.34",
      "8.8.8.8",
      "151.101.1.1",
      "2606:4700:4700::1111",
      "2a00:1450:4001::200e",
      "::ffff:8.8.8.8",
    ])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  it("a name lookup that never answers ends in the same generic error", async () => {
    const never = () => new Promise<string[]>(() => undefined);
    const err = await rejects(
      fetchBundleText("https://example.com/a", { resolveHost: never, fetchTimeoutMs: 20 }),
    );
    expect(err.message).toBe("could not download the bundle from that link");
  });

  it("every quote-like character is removed from a name in a summary", () => {
    for (const q of [
      "“",
      "”",
      "„",
      "＂",
      "″",
      "«",
      "»",
      "‘",
      "’",
      "＇",
      "`",
      "´",
      "❝",
      "〝",
      "'",
      '"',
    ])
      expect(quoteForSummary(`a${q}b`), q).toBe('"a b"');
  });

  it("the skeleton sees more look-alikes: Greek letters, digits, rn and vv", () => {
    const base = authorNameSkeleton("Tim Marlow");
    for (const v of ["Τim Marlow", "Tim Mar1ow", "Tirn Marlow", "TIM  MARLOW", "Tim Marlοw"])
      expect(authorNameSkeleton(v), v).toBe(base);
    expect(authorNameSkeleton("Wade")).toBe(authorNameSkeleton("VVade"));
    expect(authorNameSkeleton("Tim Marlowe")).not.toBe(base);
  });
});
