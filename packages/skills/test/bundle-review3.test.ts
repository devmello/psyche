import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorKeyStore, AuthorRing } from "../src/authors.ts";
import { buildBundle, bundleHashOf, signingBytes, verifyBundle } from "../src/bundle.ts";
import {
  argvCredentialLeaks,
  argvSuspectAfterFlag,
  argvSuspectWords,
  normalizeRequests,
  riskyDomains,
  scanConnector,
  unpinnedPackage,
} from "../src/connector-bundle.ts";
import { ConnectorLedger } from "../src/connector-ledger.ts";
import { createSkillsHandlers } from "../src/handlers.ts";
import { buildNotice } from "../src/notice.ts";
import { signRotation } from "../src/rotation.ts";
import { authorKey, exportOf, importer, NOW, owner, rejects, simple } from "./bundle-kit.ts";
import { approve, tempDir } from "./helpers.ts";

/**
 * Review fixes for shared connectors, rotation and notices (docs/design/shared-bundles-2026.md
 * sections 8, 9 and 11): notices that cannot undo each other, rotation that cannot take a
 * successor down, retired and forked keys, and credentials in a command line.
 */

const hashOf = (bundle: string) => bundleHashOf(signingBytes(verifyBundle(bundle).manifest));

async function install(i: ReturnType<typeof importer>, file: string, text: string) {
  const p = await i.loader.proposeImport(file, text);
  await i.loader.install(p.id, await approve(i.broker, i.clock, p));
  return p;
}

describe("M1: one author's notice never replaces another's", () => {
  async function met() {
    const i = importer();
    const ada = authorKey("Ada");
    const bo = authorKey("Bo");
    const adaBundle = buildBundle(simple("tidy"), ada, NOW);
    await install(i, "ada.psyche-skill", adaBundle);
    await install(i, "bo.psyche-skill", buildBundle(simple("other"), bo, NOW));
    return { i, ada, bo, adaBundle, hash: hashOf(adaBundle) };
  }
  const notice = (k: ReturnType<typeof authorKey>, hash: string, reason: string) =>
    buildNotice(k, { kind: "bundle", keyId: k.author.keyId, bundleHash: hash, reason }, NOW);

  it("Ada's notice first, then Bo's about the same hash: Ada's bundle stays blocked", async () => {
    const { i, ada, bo, adaBundle, hash } = await met();
    i.loader.importNotice(notice(ada, hash, "backdoor"));
    i.loader.importNotice(notice(bo, hash, "spite"));
    expect((await rejects(i.loader.proposeImport("a.psyche-skill", adaBundle))).code).toBe(
      "policy_denied",
    );
  });

  it("Bo's notice first, then Ada's: Ada's notice still counts, and Bo's never did", async () => {
    const { i, ada, bo, adaBundle, hash } = await met();
    i.loader.importNotice(notice(bo, hash, "spite"));
    expect((await i.loader.proposeImport("a.psyche-skill", adaBundle)).name).toBe("tidy");
    i.loader.importNotice(notice(ada, hash, "backdoor"));
    expect((await rejects(i.loader.proposeImport("a.psyche-skill", adaBundle))).code).toBe(
      "policy_denied",
    );
    // The same notice again changes nothing and is not an error.
    i.loader.importNotice(notice(ada, hash, "backdoor"));
  });
});

describe("M2: revoking an old key never takes its successors down", () => {
  it("B revokes A, and B's next bundle still imports", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    await install(i, "a.psyche-skill", first.bundle);
    const rotated = await o.loader.rotateAuthorKey();
    const store = new AuthorKeyStore(o.psycheHome);
    const b = store.loadOrCreate(undefined).signer;
    // B, with the chain that names it, revokes A.
    i.loader.importNotice(
      buildNotice(
        b,
        { kind: "key", keyId: first.signer.keyId, reason: "A is retired" },
        NOW,
        store.chain(),
      ),
    );
    expect(i.loader.authorState(first.signer.keyId)).toBe("revoked");
    expect(i.loader.authorState(rotated.to.keyId)).toBeUndefined();
    const next = await exportOf(o.loader, "tidy");
    const p = await i.loader.proposeImport("b.psyche-skill", next.bundle);
    // A no longer vouches for B, so B stands on its own: new or changed, never revoked.
    expect(["new", "changed"]).toContain(p.bundle?.signer.status);
    expect(p.trust).toBe("unknown");
  });

  it("A is stolen and revokes A: B, and what B signed, is unaffected", async () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const st = signRotation(a, b.author, NOW.toISOString());
    const i = importer();
    await install(i, "a.psyche-skill", buildBundle(simple("alpha"), a, NOW));
    await install(i, "b.psyche-skill", buildBundle(simple("beta"), b, NOW, "workspace", [st]));
    i.loader.importNotice(
      buildNotice(a, { kind: "key", keyId: a.author.keyId, reason: "stolen" }, NOW),
    );
    expect(i.loader.authorState(a.author.keyId)).toBe("revoked");
    expect(i.loader.authorState(b.author.keyId)).toBe("seen");
    const skills = await i.loader.listDetailed();
    expect(skills.find((s) => s.name === "alpha")?.status).toBe("blocked");
    expect(skills.find((s) => s.name === "beta")?.status).toBe("active");
    const again = await i.loader.proposeImport(
      "b2.psyche-skill",
      buildBundle(simple("beta", "", "More.\n"), b, NOW, "workspace", [st]),
    );
    expect(again.bundle?.signer.status).not.toBe("revoked");
  });

  it("a B the owner trusted directly stays trusted when A is revoked", async () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const st = signRotation(a, b.author, NOW.toISOString());
    const i = importer();
    await install(i, "a.psyche-skill", buildBundle(simple("alpha"), a, NOW));
    const p = await i.loader.proposeImport(
      "b.psyche-skill",
      buildBundle(simple("beta"), b, NOW, "workspace", [st]),
      { trustAuthor: true },
    );
    await i.loader.install(p.id, await approve(i.broker, i.clock, p));
    i.loader.setAuthorState(a.author.keyId, "revoked");
    const next = await i.loader.proposeImport(
      "b2.psyche-skill",
      buildBundle(simple("beta", "", "More.\n"), b, NOW, "workspace", [st]),
    );
    expect(next.bundle?.signer.status).toBe("trusted");
  });

  it("a bundle notice counts only when its lineage contains the bundle's actual signer", async () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const st = signRotation(a, b.author, NOW.toISOString());
    const ring = new AuthorRing(join(tempDir(), "skills"));
    const text = buildBundle(simple("tidy"), b, NOW);
    ring.observe(b.author);
    // A notice about B's bundle, signed by A (an older key B never signed as).
    const forged = buildNotice(
      a,
      { kind: "bundle", keyId: a.author.keyId, bundleHash: hashOf(text), reason: "x" },
      NOW,
    );
    ring.observe(a.author);
    const { verifyNotice } = await import("../src/notice.ts");
    ring.applyNotice(verifyNotice(forged));
    expect(ring.isBundleRevoked(hashOf(text), b.author.keyId)).toBe(false);
    // The same author's successor, naming B itself with the chain, does count.
    const good = buildNotice(
      b,
      { kind: "bundle", keyId: b.author.keyId, bundleHash: hashOf(text), reason: "x" },
      NOW,
      [st],
    );
    ring.applyNotice(verifyNotice(good));
    expect(ring.isBundleRevoked(hashOf(text), b.author.keyId)).toBe(true);
  });
});

describe("M6: a retired key of the owner's is not 'verified'", () => {
  it("shows as own but retired, trust unknown, with a warning; revoked beats retired", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    await o.loader.rotateAuthorKey();
    const p = await o.loader.proposeImport("old.psyche-skill", first.bundle);
    expect(p.bundle?.signer).toMatchObject({ status: "own", retired: true });
    expect(p.trust).toBe("unknown");
    expect(p.findings.some((f) => f.rule === "retired-key")).toBe(true);
    // The owner revokes the old key with a notice of their own; it applies on this Mac at once.
    const handlers = createSkillsHandlers(o.loader, {
      broker: o.broker,
      gates: { notice: async () => undefined },
    });
    await handlers["skills.authors.createNotice"]({
      kind: "key",
      keyId: first.signer.keyId,
      reason: "retired",
    });
    expect(o.loader.authorState(first.signer.keyId)).toBe("revoked");
    expect((await rejects(o.loader.proposeImport("old.psyche-skill", first.bundle))).code).toBe(
      "policy_denied",
    );
  });

  it("a skill installed with a retired own key loads as unknown, not verified", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const i = importer({ psycheHome: o.psycheHome });
    await install(i, "a.psyche-skill", first.bundle);
    expect((await i.loader.listDetailed()).find((s) => s.name === "tidy")?.trust).toBe("verified");
    await i.loader.rotateAuthorKey();
    expect((await i.loader.listDetailed()).find((s) => s.name === "tidy")?.trust).toBe("unknown");
  });

  it("the owner's own bundle notice takes effect locally", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const handlers = createSkillsHandlers(o.loader, {
      broker: o.broker,
      gates: { notice: async () => undefined },
    });
    await handlers["skills.authors.createNotice"]({
      kind: "bundle",
      bundleHash: hashOf(first.bundle),
      reason: "oops",
    });
    expect((await rejects(o.loader.proposeImport("x.psyche-skill", first.bundle))).code).toBe(
      "policy_denied",
    );
  });
});

describe("M7: a rotated-away key is retired, and a second successor is a fork", () => {
  it("marks a key the owner saw replaced, and refuses a competing successor", async () => {
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const c = authorKey("Ada");
    const i = importer();
    await install(
      i,
      "b.psyche-skill",
      buildBundle(simple("beta"), b, NOW, "workspace", [
        signRotation(a, b.author, NOW.toISOString()),
      ]),
    );
    // A new file from A itself is suspect now.
    const fromA = await i.loader.proposeImport(
      "a.psyche-skill",
      buildBundle(simple("alpha"), a, NOW),
    );
    expect(fromA.bundle?.signer.retired).toBe(true);
    expect(fromA.findings.some((f) => f.rule === "retired-key")).toBe(true);
    // C also claims to be A's successor: refused.
    const fork = buildBundle(simple("gamma"), c, NOW, "workspace", [
      signRotation(a, c.author, NOW.toISOString()),
    ]);
    const e = await rejects(i.loader.proposeImport("c.psyche-skill", fork));
    expect(e.code).toBe("policy_denied");
    expect(e.message).toMatch(/replace the same earlier key/);
    // Once the owner revokes B, the competing claim can be looked at.
    i.loader.setAuthorState(b.author.keyId, "revoked");
    expect((await i.loader.proposeImport("c.psyche-skill", fork)).name).toBe("gamma");
  });
});

describe("L4 and L5: notices have their own caps, and can be previewed", () => {
  it("a thousand revoked-but-unmet keys never stop a real key from being recorded", () => {
    const ring = new AuthorRing(join(tempDir(), "skills"));
    for (let n = 0; n < 520; n++)
      ring.setState(`sha256:${n.toString(16).padStart(64, "0")}`, "revoked");
    const real = authorKey("Real");
    expect(ring.observe(real.author).keyId).toBe(real.author.keyId);
    // Hundreds of owner-only file writes: slow on Windows' file system, not a hang.
  }, 60_000);

  it("a preview says what the notice would do and changes nothing; it refuses what applying would", async () => {
    const o = await owner();
    const first = await exportOf(o.loader, "tidy", "Ada");
    const i = importer();
    await install(i, "a.psyche-skill", first.bundle);
    const signer = new AuthorKeyStore(o.psycheHome).loadOrCreate(undefined).signer;
    const text = buildNotice(
      signer,
      { kind: "key", keyId: first.signer.keyId, reason: "stolen laptop" },
      NOW,
    );
    const handlers = createSkillsHandlers(i.loader, { broker: i.broker });
    const preview = await handlers["skills.authors.importNotice"]({ text, preview: true });
    expect(preview).toMatchObject({
      applied: false,
      kind: "key",
      keyId: first.signer.keyId,
      names: ["Ada"],
      alreadyRevoked: false,
      reason: "stolen laptop",
    });
    expect(preview.text).toBe(text);
    expect(i.loader.authorState(first.signer.keyId)).toBe("seen");
    const done = await handlers["skills.authors.importNotice"]({ text: preview.text });
    expect(done.applied).toBe(true);
    expect(i.loader.authorState(first.signer.keyId)).toBe("revoked");
    // A stranger's notice is refused at the preview, too.
    const stranger = authorKey("Stranger");
    await rejects(
      handlers["skills.authors.importNotice"]({
        text: buildNotice(
          stranger,
          { kind: "key", keyId: stranger.author.keyId, reason: "x" },
          NOW,
        ),
        preview: true,
      }),
    );
  });
});

describe("M4: a credential in the command line is found", () => {
  // Built at run time: the repo secret scan flags literal key shapes.
  const rand = ["Zk3", "9xQ", "7vLm", "2PaR", "8sTu", "4WnY", "6BcD", "1eFg"].join("");
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcDEFghiJKLmno"].join(".");
  const ghp = ["gh", "p_", "a".repeat(36)].join("");
  const find = (...args: string[]) => argvCredentialLeaks(args);

  it("finds web-address logins (even with no user name), secrets in a query, tokens in a path", () => {
    expect(find("https://user:pw@example.com/x")).toHaveLength(1);
    expect(find("redis://:pw@localhost:6379")).toHaveLength(1);
    expect(find(`https://${ghp}@github.com/x`)).toHaveLength(1);
    expect(find("https://api.example.com/v1?api_key=abc123")).toHaveLength(1);
    expect(find("https://api.example.com/v1?page=2&token=abc")).toHaveLength(1);
    expect(find("https://api.example.com/v1?key=abc")).toHaveLength(1);
    expect(find("https://api.example.com/v1?access_token=abc")).toHaveLength(1);
    expect(find(`https://hooks.example.com/${ghp}/send`)).toHaveLength(1);
  });

  it("finds header values and authorization words", () => {
    expect(find("Authorization: Bearer abc123def")).toHaveLength(1);
    expect(find("Authorization: abc123")).toHaveLength(1);
    expect(find("X-Api-Key: abc123")).toHaveLength(1);
    expect(find("X-Auth-Token: abc123")).toHaveLength(1);
    expect(find("bearer abcdefgh")).toHaveLength(1);
    expect(find("Cookie: session=abc")).toHaveLength(1);
  });

  it("finds key=value, flags and their values, short flags and connection strings", () => {
    expect(find("--api-key=abc123")).toHaveLength(1);
    expect(find("--access_token=abc")).toHaveLength(1);
    expect(find("password=hunter2")).toHaveLength(1);
    expect(find("--token", "abc")).toHaveLength(1);
    expect(find("--auth-token", "abc")).toHaveLength(1);
    expect(find("--client-secret", "abc")).toHaveLength(1);
    expect(find("-p", "hunter2")).toHaveLength(1);
    expect(find("-phunter2")).toHaveLength(1);
    expect(find("Server=db;Password=hunter2")).toHaveLength(1);
    expect(find("Server=db;Pwd=x;Database=d")).toHaveLength(1);
    expect(find("DefaultEndpointsProtocol=https;AccountKey=abc")).toHaveLength(1);
    expect(find(jwt)).toHaveLength(1);
    expect(find(ghp)).toHaveLength(1);
  });

  it("leaves ordinary configuration alone (no false positives)", () => {
    for (const args of [
      ["--max-tokens", "100"],
      ["--max-tokens=100"],
      ["--token-limit", "4000"],
      ["--auth-type", "basic"],
      ["--authority", "login.example.com"],
      ["--author", "bob"],
      ["--keyspace", "ks"],
      ["--primary-key", "id"],
      ["--sort-key", "name"],
      ["--bypass-cache"],
      ["--oauth-scopes", "read"],
      ["--oauth-scopes=read,write"],
      ["-p", "8080"],
      ["-p8080"],
      ["-p", "/tmp/x"],
      ["--port=8080", "--fast"],
      ["https://api.example.com/v1?page=2&limit=10"],
      ["https://user@example.com/x"],
      ["--token-file", "/path/to/file"],
      ["--api-key-env=NOTES_TOKEN", "--name=notes"],
      ["@modelcontextprotocol/server-everything@1.2.3"],
      ["server.mjs", "/Users/me/notes"],
      [`sha256:${"a".repeat(64)}`],
    ])
      expect(find(...args), args.join(" ")).toEqual([]);
  });

  it("a long random-looking word is only a warning, and a credential is a high finding that is never quoted", () => {
    expect(find(rand)).toEqual([]);
    expect(argvSuspectWords([rand])).toHaveLength(1);
    const r = normalizeRequests({ command: "node", args: ["s.mjs", rand] });
    const warn = scanConnector(r, new Map());
    expect(warn.some((f) => f.rule === "random-looking-argument" && f.severity === "warn")).toBe(
      true,
    );
    expect(warn.some((f) => f.severity === "high")).toBe(false);
    const hi = scanConnector(
      normalizeRequests({ command: "node", args: ["--token", rand] }),
      new Map(),
    );
    expect(hi.some((f) => f.rule === "credential-in-argv" && f.severity === "high")).toBe(true);
    expect(JSON.stringify([...warn, ...hi])).not.toContain(rand);
  });
});

describe("L8 and L9: broad domains, unpinned packages and package runners", () => {
  it("warns on wildcard and shared-hosting domains and on unpinned npx and uvx specs", () => {
    expect(
      riskyDomains(["api.example.com", "*.example.com", "me.github.io", "x.vercel.app"]),
    ).toEqual(["*.example.com", "me.github.io", "x.vercel.app"]);
    const un = (command: string, ...args: string[]) => unpinnedPackage({ command, args });
    expect(un("npx", "-y", "@scope/pkg")).toBe("@scope/pkg");
    expect(un("npx", "-y", "@scope/pkg@1.2.3")).toBeUndefined();
    expect(un("npx", "plain-pkg@2.0.0")).toBeUndefined();
    expect(un("uvx", "mcp-server-fetch")).toBe("mcp-server-fetch");
    expect(un("uvx", "mcp-server-fetch==0.6.2")).toBeUndefined();
    expect(un("node", "server.mjs")).toBeUndefined();
    const f = scanConnector(
      normalizeRequests({ command: "npx", args: ["-y", "@scope/pkg"], network: ["*.example.com"] }),
      new Map(),
    );
    const rules = f.map((x) => x.rule);
    expect(rules).toContain("unpinned-package");
    expect(rules).toContain("downloads-at-start");
    expect(rules).toContain("broad-domain");
  });

  it("`npx -y` is the command itself, not an install instruction", () => {
    const f = scanConnector(
      normalizeRequests({ command: "npx", args: ["-y", "@scope/pkg@1.0.0"] }),
      new Map(),
    );
    expect(f.some((x) => x.rule === "install-instructions")).toBe(false);
    expect(f.some((x) => x.severity === "high")).toBe(false);
  });
});

describe("L6: the bundle record is written to disk, keeps a copy, and can be reset", () => {
  const rec = (id: string) => ({
    serverId: id,
    bundleHash: `sha256:${"a".repeat(64)}`,
    signerAncestors: [],
    title: "T",
    createdAt: NOW.toISOString(),
    requests: normalizeRequests({ command: "node" }),
    treeHash: "sha256:x",
  });

  it("keeps the last good copy as .bak and restores it on reset", async () => {
    const { existsSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const home = tempDir();
    const l = new ConnectorLedger(home);
    l.put(rec("one"));
    l.put(rec("two"));
    expect(existsSync(`${l.path}.bak`)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(`${l.path}.bak`, "utf8")).servers)).toEqual(["one"]);
    writeFileSync(l.path, "{not json");
    expect(() => l.get("one")).toThrow();
    expect(l.reset()).toEqual({ restored: true, dropped: 0 });
    expect(l.get("one")?.serverId).toBe("one");
    // With no good copy it starts empty.
    const empty = new ConnectorLedger(tempDir());
    empty.put(rec("solo"));
    writeFileSync(empty.path, "{not json");
    expect(empty.reset()).toEqual({ restored: false, dropped: 0 });
    expect(empty.list()).toEqual([]);
    // A readable file is left alone (nothing set aside), and records outside `keep` are dropped.
    empty.put(rec("a"));
    empty.put(rec("b"));
    expect(empty.reset(new Set(["a"]))).toEqual({ restored: false, dropped: 1 });
    expect(empty.list().map((r) => r.serverId)).toEqual(["a"]);
    expect(existsSync(`${empty.path}.corrupt`)).toBe(true); // from the unreadable one above
    writeFileSync(empty.path, "{x");
    empty.reset();
    writeFileSync(empty.path, "{y");
    empty.reset();
    expect(readdirSync(join(empty.path, "..")).filter((n) => n.includes(".corrupt"))).toEqual([
      "bundles.json.corrupt",
    ]);
  });
});

describe("third review: argv credential names", () => {
  const find = (...args: string[]) => argvCredentialLeaks(args);
  const stripe = ["sk", "_test_", "a".repeat(24)].join("");
  const hf = ["hf", "_", "b".repeat(30)].join("");
  const xoxe = ["xoxe", ".", "xoxp-1-", "c".repeat(12)].join("");

  it("camelCase names, standalone key/auth/pat/passphrase, and more token prefixes", () => {
    for (const flag of [
      "--accessToken",
      "--authToken",
      "--clientSecret",
      "--privateKey",
      "--apiToken",
      "--secretKey",
      "--key",
      "--auth",
      "--pat",
      "--passphrase",
    ]) {
      expect(find(flag, "abc123"), flag).toHaveLength(1);
      expect(find(`${flag}=abc123`), `${flag}=`).toHaveLength(1);
    }
    expect(find(stripe)).toHaveLength(1);
    expect(find(hf)).toHaveLength(1);
    expect(find(xoxe)).toHaveLength(1);
  });

  it("a login after -u, a value that starts with a dash after a secret flag, and signed-URL query keys", () => {
    expect(find("-u", "bob:hunter2")).toHaveLength(1);
    expect(find("--user", "bob:hunter2")).toHaveLength(1);
    expect(find("--token", "-abc123xyz")).toHaveLength(1);
    expect(find("https://b.s3.amazonaws.com/x?X-Amz-Signature=abc")).toHaveLength(1);
    expect(find("https://b.s3.amazonaws.com/x?X-Amz-Credential=abc%2F2026")).toHaveLength(1);
    expect(find("https://x.test/y?sig=abc")).toHaveLength(1);
  });

  it("does not flag ports, addresses, plain profile words, endpoints or package names", () => {
    for (const args of [
      ["-u", "1000:1000"],
      ["-p", "8080"],
      ["-p", "8080/tcp"],
      ["-p", "0.0.0.0:80"],
      ["-p", "default"],
      ["-p", "src"],
      ["-p8080"],
      ["-pdefault"],
      ["--token-endpoint", "https://auth.example.com/token"],
      ["--secret-store", "vault"],
      ["--key-uri", "kms://x"],
      ["--keystore", "ks"],
      ["--truststore", "ts"],
      ["--cookie-jar", "jar.txt"],
      ["--token", "--verbose"],
      ["sk-mcp-server"],
      ["@acme/sk-mcp-server@1.2.3"],
    ])
      expect(find(...args), args.join(" ")).toEqual([]);
  });

  it("on export, a random-looking value right after a flag is a credential", () => {
    const rand = ["Zk3", "9xQ", "7vLm", "2PaR", "8sTu", "4WnY", "6BcD", "1eFg"].join("");
    expect(argvSuspectAfterFlag(["--session", rand])).toHaveLength(1);
    expect(argvSuspectAfterFlag([rand])).toEqual([]);
    expect(argvSuspectAfterFlag(["--name", "plain"])).toEqual([]);
  });
});
