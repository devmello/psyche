import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorRing, type RingUndo } from "../src/authors.ts";
import { buildBundle, bundleHashOf, signingBytes, verifyBundle } from "../src/bundle.ts";
import { buildNotice, verifyNotice } from "../src/notice.ts";
import { signRotation } from "../src/rotation.ts";
import { authorKey, importer, NOW, rejects, simple } from "./bundle-kit.ts";
import { approve, tempDir } from "./helpers.ts";

/** Second review of shared connectors, rotation and notices: what is left of the key rules. */

const hashOf = (bundle: string) => bundleHashOf(signingBytes(verifyBundle(bundle).manifest));

async function install(i: ReturnType<typeof importer>, file: string, text: string, trust = false) {
  const p = await i.loader.proposeImport(file, text, trust ? { trustAuthor: true } : {});
  await i.loader.install(p.id, await approve(i.broker, i.clock, p));
  return p;
}

describe("2: the fork check cannot be got past by the order cards are approved in", () => {
  it("a competing successor staged first is refused when it is approved after the other one", async () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const c = authorKey("Ada");
    const i = importer();
    const pB = await i.loader.proposeImport(
      "b.psyche-skill",
      buildBundle(simple("beta"), b, NOW, "workspace", [
        signRotation(a, b.author, NOW.toISOString()),
      ]),
    );
    // Nothing is known about A's successors yet, so C stages fine as well.
    const pC = await i.loader.proposeImport(
      "c.psyche-skill",
      buildBundle(simple("gamma"), c, NOW, "workspace", [
        signRotation(a, c.author, NOW.toISOString()),
      ]),
    );
    const okB = await approve(i.broker, i.clock, pB);
    const okC = await approve(i.broker, i.clock, pC);
    await i.loader.install(pB.id, okB);
    const e = await rejects(i.loader.install(pC.id, okC));
    expect(e.code).toBe("policy_denied");
    expect(e.message).toMatch(/replace the same earlier key/);
    expect((await i.loader.listDetailed()).some((s) => s.name === "gamma")).toBe(false);
  });
});

describe("6: each lineage root has a notice quota of its own; the owner's own notices are never refused", () => {
  function setup() {
    const ring = new AuthorRing(join(tempDir(), "skills"));
    const bundle = buildBundle(simple("tidy"), authorKey("Victim"), NOW);
    const hash = hashOf(bundle);
    const victim = verifyBundle(bundle).signer?.keyId as string;
    return { ring, hash, victim };
  }
  // A notice from `key` (rooted at `root`, through a rotation statement) about `hash`.
  const notice = (root: ReturnType<typeof authorKey>, hash: string) => {
    const k = authorKey("Root");
    const text = buildNotice(
      k,
      { kind: "bundle", keyId: k.author.keyId, bundleHash: hash, reason: "x" },
      NOW,
      [signRotation(root, k.author, NOW.toISOString())],
    );
    return verifyNotice(text);
  };

  it("one root cannot crowd out another, and a full root still lets the owner's notice in", () => {
    const { ring, hash } = setup();
    const crowd = authorKey("Crowd");
    const honest = authorKey("Honest");
    ring.observe(crowd.author);
    ring.observe(honest.author);
    for (let n = 0; n < 3; n++) ring.applyNotice(notice(crowd, hash));
    expect(() => ring.applyNotice(notice(crowd, hash))).toThrow(/too many notices/);
    // Another root is not affected by it.
    ring.applyNotice(notice(honest, hash));
    // The owner's own notice is never refused.
    const own = authorKey("Owner");
    ring.applyNotice(
      verifyNotice(
        buildNotice(
          own,
          { kind: "bundle", keyId: own.author.keyId, bundleHash: hash, reason: "mine" },
          NOW,
        ),
      ),
      { trustedLocal: true },
    );
  });
});

describe("7: a key that was replaced is not 'verified', even if the owner trusted it", () => {
  it("shows as trusted but retired, installs as unknown, and an installed skill loses the label", async () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const i = importer();
    await install(i, "a.psyche-skill", buildBundle(simple("alpha"), a, NOW), true);
    expect((await i.loader.listDetailed()).find((s) => s.name === "alpha")?.trust).toBe("verified");
    await install(
      i,
      "b.psyche-skill",
      buildBundle(simple("beta"), b, NOW, "workspace", [
        signRotation(a, b.author, NOW.toISOString()),
      ]),
    );
    // The owner has now seen A replaced by B.
    expect((await i.loader.listDetailed()).find((s) => s.name === "alpha")?.trust).toBe("unknown");
    const again = await i.loader.proposeImport(
      "a2.psyche-skill",
      buildBundle(simple("alpha", "", "More.\n"), a, NOW),
    );
    expect(again.bundle?.signer).toMatchObject({ status: "trusted", retired: true });
    expect(again.trust).toBe("unknown");
    expect(again.findings.some((f) => f.rule === "retired-key")).toBe(true);
  });
});

describe("9: undoing an install puts back only what that install wrote", () => {
  it("forgets a key that was only just seen, and the rotation pair it added", () => {
    const ring = new AuthorRing(join(tempDir(), "skills"));
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const undo: RingUndo = { pairs: [] };
    ring.observe(b.author, [a.author.keyId], undo);
    expect(ring.get(b.author.keyId)).toBeDefined();
    expect(ring.isRetired(a.author.keyId)).toBe(true);
    ring.rollback(undo);
    expect(ring.get(b.author.keyId)).toBeUndefined();
    expect(ring.isRetired(a.author.keyId)).toBe(false);
  });

  it("never wipes the rotations another install recorded for the same key", () => {
    const ring = new AuthorRing(join(tempDir(), "skills"));
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const c = authorKey("Ada");
    // An earlier install recorded A -> B.
    ring.observe(b.author, [a.author.keyId]);
    // A later one names A -> C as well, and is undone.
    const undo: RingUndo = { pairs: [] };
    ring.observe(c.author, [a.author.keyId], undo);
    expect(undo.pairs).toEqual([[a.author.keyId, c.author.keyId]]);
    ring.rollback(undo);
    expect(ring.isRetired(a.author.keyId)).toBe(true);
    // A -> B is still known: a second successor is still a fork.
    expect(() => ring.assertNoFork(c.author.keyId, [a.author.keyId])).toThrow(/same earlier key/);
    ring.assertNoFork(b.author.keyId, [a.author.keyId]);
  });

  it("keeps what the owner decided in the meantime, and keys already known", () => {
    const ring = new AuthorRing(join(tempDir(), "skills"));
    const b = authorKey("Bo");
    const undo: RingUndo = { pairs: [] };
    ring.observe(b.author, [], undo);
    ring.setState(b.author.keyId, "trusted");
    ring.rollback(undo);
    expect(ring.get(b.author.keyId)?.state).toBe("trusted");
    const c = authorKey("Cy");
    ring.observe(c.author);
    const again: RingUndo = { pairs: [] };
    ring.observe(c.author, [], again);
    expect(again.key).toBeUndefined();
    ring.rollback(again);
    expect(ring.get(c.author.keyId)).toBeDefined();
  });
});
