import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { AuthorKeyStore } from "../src/authors.ts";
import { buildBundle, verifyBundle } from "../src/bundle.ts";
import { fetchBundleText } from "../src/bundle-url.ts";
import { createSkillsHandlers } from "../src/handlers.ts";
import { buildNotice, MAX_NOTICE_BYTES, verifyNotice } from "../src/notice.ts";
import { signRotation, verifyRotationChain } from "../src/rotation.ts";
import { authorKey, exportOf, importer, NOW, owner, rejects, simple } from "./bundle-kit.ts";
import { approve, tempDir } from "./helpers.ts";

/** Key rotation and signed revocation notices (docs/design/shared-bundles-2026.md section 9). */

// biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary parsed JSON
type Json = Record<string, any>;

const edited = (text: string, edit: (j: Json) => void) => {
  const j = JSON.parse(text);
  edit(j);
  return JSON.stringify(j);
};
const reply = (body: string) => new Response(body, { status: 200 });
const publicDns = async () => ["93.184.216.34"];

describe("rotation statements", () => {
  it("a statement signed by the old key verifies and lists the earlier keys, nearest first", () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const c = authorKey("Ada");
    const ab = signRotation(a, b.author, NOW.toISOString());
    const bc = signRotation(b, c.author, NOW.toISOString());
    expect(verifyRotationChain([ab], b.author)).toEqual([a.author.keyId]);
    expect(verifyRotationChain([ab, bc], c.author)).toEqual([b.author.keyId, a.author.keyId]);
  });

  it("refuses a forged, edited, mis-ended or broken chain", () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const m = authorKey("Mallory");
    const good = signRotation(a, b.author, NOW.toISOString());
    // Mallory names her own key as Ada's successor, signing with her own key: not signed by `from`.
    const forged = {
      from: { keyId: a.author.keyId, publicKey: a.author.publicKey },
      to: { keyId: m.author.keyId, publicKey: m.author.publicKey, name: "Ada" },
      createdAt: NOW.toISOString(),
      signature: signRotation(m, m.author, NOW.toISOString()).signature,
    };
    expect(() => verifyRotationChain([forged], m.author)).toThrow(
      /not signed by the key it replaces/,
    );
    // A valid signature moved onto another successor.
    expect(() =>
      verifyRotationChain([{ ...good, to: { ...good.to, ...m.author } }], m.author),
    ).toThrow(/not signed by the key it replaces/);
    // The chain must end at the key that signed the file, under the same name.
    expect(() => verifyRotationChain([good], m.author)).toThrow(/does not end/);
    expect(() => verifyRotationChain([good], { ...b.author, name: "Someone else" })).toThrow(
      /another name/,
    );
    // Gaps, loops and self-replacement.
    const c = authorKey("Ada");
    const bc = signRotation(b, c.author, NOW.toISOString());
    expect(() =>
      verifyRotationChain([good, signRotation(m, c.author, NOW.toISOString())], c.author),
    ).toThrow(/follow each other/);
    expect(() =>
      verifyRotationChain([good, bc, signRotation(c, a.author, NOW.toISOString())], a.author),
    ).toThrow(/twice/);
    expect(() =>
      verifyRotationChain([signRotation(a, a.author, NOW.toISOString())], a.author),
    ).toThrow(/replace itself/);
    // A key id that is not its key's fingerprint.
    expect(() =>
      verifyRotationChain([{ ...good, to: { ...good.to, keyId: m.author.keyId } }], {
        ...b.author,
        keyId: m.author.keyId,
      }),
    ).toThrow(/fingerprint/);
  });

  it("a bundle carries the chain: a forged one refuses the whole file, never 'unsigned'", () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const m = authorKey("Mallory");
    const st = signRotation(a, b.author, NOW.toISOString());
    const ok = buildBundle(simple("tidy"), b, NOW, "workspace", [st]);
    expect(verifyBundle(ok).ancestors).toEqual([a.author.keyId]);
    expect(verifyBundle(buildBundle(simple("tidy"), b, NOW)).ancestors).toEqual([]);
    // Mallory's key signs the file and carries a statement she forged from Ada's key.
    const forged = signRotation(m, m.author, NOW.toISOString());
    const bad = buildBundle(simple("tidy"), m, NOW, "workspace", [
      { ...forged, from: { keyId: a.author.keyId, publicKey: a.author.publicKey } },
    ]);
    expect(() => verifyBundle(bad)).toThrow(/rotation statement/);
    // A chain with no signature to go with it.
    expect(() =>
      verifyBundle(edited(buildBundle(simple("tidy"), undefined, NOW), (j) => (j.rotation = [st]))),
    ).toThrow(/needs a signed bundle/);
    // Unknown fields in a statement.
    expect(() => verifyBundle(edited(ok, (j) => (j.rotation[0].note = "x")))).toThrow(
      /unknown field/,
    );
  });
});

describe("rotating the owner's author key", () => {
  it("replaces the key with a statement from the old one and drops the old private key", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const store = new AuthorKeyStore(o.psycheHome);
    const before = readFileSync(store.path, "utf8");
    const oldD = JSON.parse(before).jwk.d as string;
    const r = await o.loader.rotateAuthorKey();
    expect(r.from.keyId).toBe(first.signer.keyId);
    expect(r.to.keyId).not.toBe(first.signer.keyId);
    expect(r.to.name).toBe("Ada");
    const after = readFileSync(store.path, "utf8");
    expect(after).not.toContain(oldD);
    expect(readFileSync(store.rotationPath, "utf8")).not.toContain(oldD);
    expect(statSync(store.path).mode & 0o077).toBe(0);
    expect(statSync(store.rotationPath).mode & 0o077).toBe(0);
    expect(store.chain()).toHaveLength(1);
    expect(store.retiredKeyIds()).toEqual([first.signer.keyId]);
    // The new key's bundles carry the statement; it verifies for anyone.
    const second = await exportOf(o.loader, "tidy");
    expect(second.signer.keyId).toBe(r.to.keyId);
    expect(verifyBundle(second.bundle).ancestors).toEqual([first.signer.keyId]);
    // Rotating twice keeps the whole chain.
    await o.loader.rotateAuthorKey();
    expect(store.chain()).toHaveLength(2);
    const third = await exportOf(o.loader, "tidy");
    expect(verifyBundle(third.bundle).ancestors).toEqual([r.to.keyId, first.signer.keyId]);
  });

  it("there is nothing to rotate before the first export, and the rotation is audited before it returns", async () => {
    const events: string[] = [];
    const o = await owner({
      onAuthorChange: async (e: { kind: string }) => {
        await new Promise((r) => setTimeout(r, 5));
        events.push(e.kind);
      },
    });
    expect((await rejects(o.loader.rotateAuthorKey())).code).toBe("conflict");
    await exportOf(o.loader, "tidy", "Ada");
    await o.loader.rotateAuthorKey();
    events.push("returned");
    expect(events.slice(-2)).toEqual(["author_key_rotated", "returned"]);
  });

  it("the owner's own old bundles are still 'own' after a rotation", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    await o.loader.rotateAuthorKey();
    const again = await o.loader.proposeImport("old.psyche-skill", first.bundle);
    expect(again.bundle?.signer.status).toBe("own");
  });

  it("an importer who trusted the old key sees 'same author, new key', and the new key is not trusted", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const p1 = await i.loader.proposeImport("a.psyche-skill", first.bundle, { trustAuthor: true });
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    expect(i.loader.authorState(first.signer.keyId)).toBe("trusted");

    const rotated = await o.loader.rotateAuthorKey();
    const second = await exportOf(o.loader, "tidy");
    const p2 = await i.loader.proposeImport("b.psyche-skill", second.bundle);
    expect(p2.bundle?.signer).toMatchObject({
      status: "rotated",
      keyId: rotated.to.keyId,
      previousKeyId: first.signer.keyId,
      rotatedFrom: { keyId: first.signer.keyId, state: "trusted" },
      signerChanged: false,
    });
    expect(p2.findings.some((f) => f.rule === "signer-rotated")).toBe(true);
    // The rotation explains the change but trusts nothing: the install is not verified, the
    // new key is not in the trusted list, and trusting it is the owner's separate act.
    expect(p2.trust).toBe("unknown");
    expect(i.loader.authorState(rotated.to.keyId)).toBeUndefined();
    await i.loader.install(p2.id, await approve(i.broker, i.clock, p2));
    expect(i.loader.authorState(rotated.to.keyId)).toBe("seen");
    expect(i.loader.authorState(first.signer.keyId)).toBe("trusted");

    // Without the statement it is the old, louder 'changed' for someone who installed with the old key.
    const stripped = edited(second.bundle, (j) => delete j.rotation);
    const p3 = await importer().loader.proposeImport("c.psyche-skill", stripped);
    expect(p3.bundle?.signer.status).toBe("new");
    const j = importer();
    const q1 = await j.loader.proposeImport("a.psyche-skill", first.bundle, { trustAuthor: true });
    await j.loader.install(q1.id, await approve(j.broker, j.clock, q1));
    const q2 = await j.loader.proposeImport("c.psyche-skill", stripped);
    expect(q2.bundle?.signer.status).toBe("changed");
    expect(q2.bundle?.signer.signerChanged).toBe(true);
  });

  it("trusting the new key still goes through the presence gate", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const p1 = await i.loader.proposeImport("a.psyche-skill", first.bundle, { trustAuthor: true });
    await i.loader.install(p1.id, await approve(i.broker, i.clock, p1));
    const rotated = await o.loader.rotateAuthorKey();
    const second = await exportOf(o.loader, "tidy");
    const p2 = await i.loader.proposeImport("b.psyche-skill", second.bundle);
    await i.loader.install(p2.id, await approve(i.broker, i.clock, p2));
    const gated: string[] = [];
    const handlers = createSkillsHandlers(i.loader, {
      broker: i.broker,
      gates: {
        authorChange: async (_c, a) => {
          gated.push(`${a.keyId}:${a.to}`);
          throw new PsycheError("approval_required", "needs presence");
        },
      },
    });
    await rejects(handlers["skills.authors.set"]({ keyId: rotated.to.keyId, state: "trusted" }));
    expect(gated).toEqual([`${rotated.to.keyId}:trusted`]);
    expect(i.loader.authorState(rotated.to.keyId)).toBe("seen");
  });
});

describe("revocation notices", () => {
  const key = authorKey("Ada");
  const keyNotice = (signer = key, keyId = signer.author.keyId) =>
    buildNotice(signer, { kind: "key", keyId, reason: "my laptop was stolen" }, NOW);

  it("verifies a signed notice and refuses an unsigned, forged, oversized or malformed one", () => {
    const text = keyNotice();
    const v = verifyNotice(text);
    expect(v.notice).toMatchObject({ kind: "key", keyId: key.author.keyId });
    expect(v.notice.signer).toEqual(key.author);
    // No signature at all is an error, not a weaker notice.
    expect(() => verifyNotice(edited(text, (j) => delete j.signature))).toThrow(
      /signature|missing/,
    );
    // Edited after signing.
    expect(() => verifyNotice(edited(text, (j) => (j.notice.reason = "fine, ignore")))).toThrow(
      /signature does not verify/,
    );
    expect(() =>
      verifyNotice(edited(text, (j) => (j.notice.keyId = `sha256:${"1".repeat(64)}`))),
    ).toThrow(/signature does not verify/);
    // Signed by someone else but claiming Ada's key.
    const m = authorKey("Mallory");
    expect(() => verifyNotice(edited(text, (j) => (j.notice.signer = m.author)))).toThrow(
      /signature does not verify/,
    );
    expect(() => verifyNotice("x".repeat(MAX_NOTICE_BYTES + 1))).toThrow(/larger than/);
    expect(() => verifyNotice(edited(text, (j) => (j.extra = 1)))).toThrow(/unknown field/);
    expect(() => verifyNotice(edited(text, (j) => (j.notice.kind = "everything")))).toThrow(/kind/);
    // A bundle notice names a hash; a key notice does not.
    expect(() =>
      buildNotice(key, { kind: "bundle", keyId: key.author.keyId, reason: "bad" }, NOW),
    ).toThrow(/bundle hash/);
    expect(() =>
      buildNotice(
        key,
        {
          kind: "key",
          keyId: key.author.keyId,
          bundleHash: `sha256:${"2".repeat(64)}`,
          reason: "x",
        },
        NOW,
      ),
    ).toThrow(/names no bundle/);
  });

  async function seen() {
    const o = await owner();
    const exported = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    const p = await i.loader.proposeImport("a.psyche-skill", exported.bundle);
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    return { o, exported, i };
  }

  it("a notice from a key the owner has seen revokes that key, and its skills stop", async () => {
    const { o, exported, i } = await seen();
    const store = new AuthorKeyStore(o.psycheHome);
    const signer = store.loadOrCreate(undefined).signer;
    const notice = buildNotice(
      signer,
      { kind: "key", keyId: exported.signer.keyId, reason: "key stolen" },
      NOW,
    );
    const applied = i.loader.importNotice(notice);
    expect(applied).toMatchObject({
      kind: "key",
      keyId: exported.signer.keyId,
      reason: "key stolen",
    });
    expect(i.loader.authorState(exported.signer.keyId)).toBe("revoked");
    expect((await i.loader.listDetailed()).find((s) => s.name === "tidy")?.status).toBe("blocked");
    expect((await rejects(i.loader.proposeImport("a.psyche-skill", exported.bundle))).code).toBe(
      "policy_denied",
    );
  });

  it("an unknown-key notice is refused and changes nothing", async () => {
    const { i } = await seen();
    const stranger = authorKey("Stranger");
    const before = JSON.stringify(i.loader.authors());
    const e = await rejects(() =>
      i.loader.importNotice(
        buildNotice(stranger, { kind: "key", keyId: stranger.author.keyId, reason: "boo" }, NOW),
      ),
    );
    expect(e.code).toBe("policy_denied");
    expect(e.message).toMatch(/have not met/);
    expect(JSON.stringify(i.loader.authors())).toBe(before);
    // Nor can a stranger revoke a key the owner has seen, or park a hash against it.
    const { exported } = await seen();
    expect(() =>
      importer().loader.importNotice(
        buildNotice(stranger, { kind: "key", keyId: exported.signer.keyId, reason: "x" }, NOW),
      ),
    ).toThrow(/have not met/);
  });

  it("an unsigned notice is refused", async () => {
    const { i, exported } = await seen();
    const unsigned = edited(
      buildNotice(
        authorKey("Ada"),
        { kind: "key", keyId: exported.signer.keyId, reason: "x" },
        NOW,
      ),
      (j) => delete j.signature,
    );
    expect(() => i.loader.importNotice(unsigned)).toThrow();
    expect(i.loader.authorState(exported.signer.keyId)).toBe("seen");
  });

  it("a seen key cannot revoke somebody else's key", async () => {
    const { i } = await seen();
    // Bo signs a bundle the importer installs, so Bo's key has been seen as well.
    const bo = authorKey("Bo");
    const pb = await i.loader.proposeImport(
      "bo.psyche-skill",
      buildBundle(simple("other"), bo, NOW),
    );
    await i.loader.install(pb.id, await approve(i.broker, i.clock, pb));
    const ada = i.loader.authors().authors.find((a) => a.names.includes("Ada"));
    const e = await rejects(() =>
      i.loader.importNotice(
        buildNotice(bo, { kind: "key", keyId: ada?.keyId as string, reason: "go away" }, NOW),
      ),
    );
    expect(e.code).toBe("policy_denied");
    expect(e.message).toMatch(/own keys or bundles/);
    expect(i.loader.authorState(ada?.keyId as string)).toBe("seen");
  });

  it("a successor key can revoke the key it replaced, even if the owner only met the old one", async () => {
    const { o, exported, i } = await seen();
    await o.loader.rotateAuthorKey();
    const store = new AuthorKeyStore(o.psycheHome);
    const signer = store.loadOrCreate(undefined).signer;
    const notice = buildNotice(
      signer,
      { kind: "key", keyId: exported.signer.keyId, reason: "old key leaked" },
      NOW,
      store.chain(),
    );
    expect(i.loader.authorState(signer.author.keyId)).toBeUndefined();
    i.loader.importNotice(notice);
    expect(i.loader.authorState(exported.signer.keyId)).toBe("revoked");
  });

  it("a bundle notice blocks exactly that bundle, also for a card already staged", async () => {
    const { o, exported, i } = await seen();
    const j = importer();
    const staged = await j.loader.proposeImport("a.psyche-skill", exported.bundle);
    const approvalId = await approve(j.broker, j.clock, staged);
    // Ada has to have been met for the notice to count: j met her key through an install of another file.
    const other = await exportOf(o.loader, "tidy");
    const pj = await j.loader.proposeImport("c.psyche-skill", other.bundle);
    await j.loader.install(pj.id, await approve(j.broker, j.clock, pj));

    const hash = (await import("../src/bundle.ts")).bundleHashOf(
      (await import("../src/bundle.ts")).signingBytes(verifyBundle(exported.bundle).manifest),
    );
    const signer = new AuthorKeyStore(o.psycheHome).loadOrCreate(undefined).signer;
    j.loader.importNotice(
      buildNotice(
        signer,
        {
          kind: "bundle",
          keyId: exported.signer.keyId,
          bundleHash: hash,
          reason: "contains a backdoor",
        },
        NOW,
      ),
    );
    expect((await rejects(j.loader.install(staged.id, approvalId))).code).toBe("policy_denied");
    expect((await rejects(j.loader.proposeImport("a.psyche-skill", exported.bundle))).code).toBe(
      "policy_denied",
    );
    // The key itself is not revoked, and another bundle of the same author still imports.
    expect(j.loader.authorState(exported.signer.keyId)).not.toBe("revoked");
    const fresh = buildBundle(simple("tidy", "", "Fixed.\n"), signer, NOW);
    expect((await j.loader.proposeImport("d.psyche-skill", fresh)).name).toBe("tidy");
    void i;
  });

  it("a notice about a bundle only counts against the author who signed that bundle", async () => {
    const { o, exported, i } = await seen();
    const bo = authorKey("Bo");
    const pb = await i.loader.proposeImport(
      "bo.psyche-skill",
      buildBundle(simple("other"), bo, NOW),
    );
    await i.loader.install(pb.id, await approve(i.broker, i.clock, pb));
    const { bundleHashOf, signingBytes } = await import("../src/bundle.ts");
    const hash = bundleHashOf(signingBytes(verifyBundle(exported.bundle).manifest));
    // Bo (seen) names Ada's bundle hash under Bo's own key: stored, but Ada's bundle is not Bo's.
    i.loader.importNotice(
      buildNotice(
        bo,
        { kind: "bundle", keyId: bo.author.keyId, bundleHash: hash, reason: "spite" },
        NOW,
      ),
    );
    expect((await i.loader.proposeImport("a.psyche-skill", exported.bundle)).name).toBe("tidy");
    void o;
  });

  it("imports a notice from a link under the bundle-link rules and the notice size cap", async () => {
    const o = await owner();
    const exported = await exportOf(o.loader, "tidy", "Ada");
    const signer = new AuthorKeyStore(o.psycheHome).loadOrCreate(undefined).signer;
    const notice = buildNotice(
      signer,
      { kind: "key", keyId: exported.signer.keyId, reason: "rotate away" },
      NOW,
    );
    const j = importer({
      sourceOptions: { fetchImpl: async () => reply(notice), resolveHost: publicDns },
    });
    const pj = await j.loader.proposeImport("a.psyche-skill", exported.bundle);
    await j.loader.install(pj.id, await approve(j.broker, j.clock, pj));
    const h = createSkillsHandlers(j.loader, { broker: j.broker });
    // A link and text together, or neither, is a mistake.
    await rejects(h["skills.authors.importNotice"]({ text: notice, url: "https://example.com/n" }));
    await rejects(h["skills.authors.importNotice"]({}));
    // Plain http and local names are refused before any request.
    await rejects(h["skills.authors.importNotice"]({ url: "http://example.com/n" }));
    await rejects(h["skills.authors.importNotice"]({ url: "https://localhost/n" }));
    expect(j.loader.authorState(exported.signer.keyId)).toBe("seen");
    // The link is fetched, verified and applied.
    const r = await h["skills.authors.importNotice"]({ url: "https://example.com/n" });
    expect(r).toMatchObject({ kind: "key", keyId: exported.signer.keyId, reason: "rotate away" });
    expect(j.loader.authorState(exported.signer.keyId)).toBe("revoked");
    // The notice cap is far below the bundle cap.
    await rejects(
      fetchBundleText("https://example.com/n", {
        fetchImpl: async () => reply("x".repeat(MAX_NOTICE_BYTES + 1)),
        resolveHost: publicDns,
        maxBytes: MAX_NOTICE_BYTES,
      }),
    );
    const big = importer({
      sourceOptions: {
        fetchImpl: async () => reply("x".repeat(MAX_NOTICE_BYTES + 1)),
        resolveHost: publicDns,
      },
    });
    const hb = createSkillsHandlers(big.loader, { broker: big.broker });
    expect(
      (await rejects(hb["skills.authors.importNotice"]({ url: "https://example.com/n" }))).message,
    ).toMatch(/larger than/);
  });

  it("an author signs a notice behind the Gateway's gate, and can name an earlier key after rotating", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const gated: string[] = [];
    const handlers = createSkillsHandlers(o.loader, {
      broker: o.broker,
      gates: {
        notice: async (_c, a) => {
          gated.push(`${a.kind}:${a.keyId}`);
        },
      },
    });
    const r = await handlers["skills.authors.createNotice"]({ kind: "key", reason: "retiring" });
    expect(r.filename.endsWith(".psyche-notice")).toBe(true);
    expect(verifyNotice(r.notice).notice.keyId).toBe(first.signer.keyId);
    // Not somebody else's key.
    const other = authorKey("Mallory");
    expect(
      (
        await rejects(
          handlers["skills.authors.createNotice"]({
            kind: "key",
            keyId: other.author.keyId,
            reason: "x",
          }),
        )
      ).code,
    ).toBe("invalid_params");
    // After rotating, the new key signs a notice for the old one, carrying the chain.
    await o.loader.rotateAuthorKey();
    const r2 = await handlers["skills.authors.createNotice"]({
      kind: "key",
      keyId: first.signer.keyId,
      reason: "old key retired",
    });
    const v = verifyNotice(r2.notice);
    expect(v.ancestors).toEqual([first.signer.keyId]);
    expect(gated).toHaveLength(2);
    // No gate, no signature.
    const bare = createSkillsHandlers(o.loader, { broker: o.broker });
    expect(
      (await rejects(bare["skills.authors.createNotice"]({ kind: "key", reason: "x" }))).code,
    ).toBe("unavailable");
    expect((await rejects(bare["skills.authors.rotate"]({}))).code).toBe("unavailable");
  });
});

describe("the author key store", () => {
  it("never creates a key by rotating, and ignores statements that do not lead to the current key", () => {
    const home = join(tempDir("psyche-keys-"), "home");
    const store = new AuthorKeyStore(home);
    expect(() => store.rotate(NOW)).toThrow(/no author key/);
    expect(store.chain()).toEqual([]);
    store.loadOrCreate("Ada");
    expect(store.chain()).toEqual([]);
    const r = store.rotate(NOW);
    expect(store.chain().map((s) => s.to.keyId)).toEqual([r.to.keyId]);
  });
});
