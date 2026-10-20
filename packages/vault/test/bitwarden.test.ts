import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolvedSecret } from "@psyche/protocol";
import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BwCliSource, checkBitwardenRef, createVaultHandlers } from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";
import { VISA } from "./samples.ts";

const PW = "bitwarden-sourced-pw-47";
const API_TOKEN = "bw_api_token_0123456789abcdef";
// Built at runtime so the repository's secret scanner finds no PEM header literal.
const SSH_KEY = [
  "-----BEGIN ",
  "OPENSSH PRIVATE KEY-----\nbitwarden-fake-key-body\n-----END ",
  "OPENSSH PRIVATE KEY-----",
].join("");
const SESSION = "bw_fake_session_key_Zm9vYmFyYmF6cXV4";
const GH = { kind: "origin" as const, value: "https://github.com" };
const API = { kind: "origin" as const, value: "https://api.example.com" };

/**
 * A fake `bw` on disk, run through the real `execFile` path: it reads items from its app-data dir
 * (`BITWARDENCLI_APPDATA_DIR`), answers like the CLI (values without a newline, "Not found.",
 * "More than one result was found.", "Vault is locked."), and logs argv and env names per call.
 */
const FAKE_BW = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.BITWARDENCLI_APPDATA_DIR;
const fx = JSON.parse(fs.readFileSync(path.join(dir, "fixture.json"), "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, env: Object.keys(process.env).sort() }) + "\\n");
const die = (msg) => { process.stderr.write(msg); process.exit(1); };
if (process.env.BW_SESSION !== fx.session) {
  if (argv[0] === "status") { process.stdout.write(JSON.stringify({ status: "locked" })); process.exit(0); }
  die("Vault is locked.");
}
if (argv[0] === "status") { process.stdout.write(JSON.stringify({ status: "unlocked" })); process.exit(0); }
if (argv[0] !== "get") die("unknown command");
const [, what, ref] = argv;
const hits = fx.items.filter((i) => i.id === ref || i.name === ref);
if (hits.length === 0) die("Not found.");
if (hits.length > 1) die("More than one result was found. Try getting a specific object by \`id\` instead.");
const item = hits[0];
const out = (v) => { if (v == null || v === "") die("Not found."); process.stdout.write(String(v)); process.exit(0); };
if (what === "item") out(JSON.stringify(item));
if (what === "username") out(item.login && item.login.username);
if (what === "password") out(item.login && item.login.password);
if (what === "totp") out(item.login && item.login.totp ? "492039" : null);
if (what === "notes") out(item.notes);
die("unknown object");
`;

interface Fake {
  dir: string;
  bin: string;
  calls(): { argv: string[]; env: string[] }[];
  cleanup(): void;
}

function fakeBw(): Fake {
  const dir = mkdtempSync(join(tmpdir(), "psyche-bw-"));
  const bin = join(dir, "bw");
  writeFileSync(bin, FAKE_BW);
  chmodSync(bin, 0o755);
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      session: SESSION,
      items: [
        {
          id: "0b1c2d3e-0000-4000-8000-000000000001",
          type: 1,
          name: "GitHub",
          login: { username: "pat", password: PW, totp: "JBSWY3DPEHPK3PXP" },
          notes: null,
          fields: [],
        },
        {
          id: "0b1c2d3e-0000-4000-8000-000000000002",
          type: 1,
          name: "Example API",
          login: { username: null, password: "not-the-token" },
          fields: [{ name: "API key", value: API_TOKEN, type: 1 }],
        },
        {
          id: "0b1c2d3e-0000-4000-8000-000000000003",
          type: 5,
          name: "build box",
          sshKey: { privateKey: SSH_KEY, publicKey: "ssh-ed25519 AAAA" },
        },
        {
          id: "0b1c2d3e-0000-4000-8000-000000000004",
          type: 3,
          name: "Visa",
          card: { number: VISA, code: "737" },
          fields: [{ name: "token", value: "card-token" }],
        },
        {
          id: "0b1c2d3e-0000-4000-8000-000000000005",
          type: 1,
          name: "Billing API",
          login: { password: "x" },
          fields: [{ name: "token", value: `card ${VISA}` }],
        },
        { id: "0b1c2d3e-0000-4000-8000-000000000006", type: 1, name: "Twin", login: {} },
        { id: "0b1c2d3e-0000-4000-8000-000000000007", type: 1, name: "Twin", login: {} },
      ],
    }),
  );
  return {
    dir,
    bin,
    calls: () =>
      readFileSync(join(dir, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { argv: string[]; env: string[] }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const sessionOf = (value: string) => async () =>
  new ResolvedSecret(value, {
    credentialId: "cred_bw",
    target: { kind: "account", value: "bitwarden" },
  });

let fake: Fake;
beforeEach(() => {
  fake = fakeBw();
  registerSecret(PW, "pw");
  registerSecret(API_TOKEN, "api");
  registerSecret(SESSION, "session");
});
afterEach(() => {
  fake.cleanup();
  clearSecrets();
});

const source = (session = SESSION) =>
  new BwCliSource({ bw: fake.bin, session: sessionOf(session), appDataDir: fake.dir });

describe("BwCliSource (G11)", () => {
  it("reads one field per call with the session only in the child's env", async () => {
    const bw = source();
    expect(await bw.readField({ item: "GitHub" }, "password")).toBe(PW);
    expect(await bw.readField({ item: "GitHub" }, "username")).toBe("pat");
    expect(await bw.readField({ item: "GitHub" }, "totp")).toBe("492039");
    expect(await bw.readField({ item: "Example API" }, "token")).toBe(API_TOKEN);
    expect(await bw.readField({ item: "build box" }, "private_key")).toBe(SSH_KEY);
    expect(await bw.unavailableReason()).toBeNull();
    const calls = fake.calls();
    expect(calls.map((c) => c.argv)).toEqual([
      ["get", "password", "GitHub", "--nointeraction"],
      ["get", "username", "GitHub", "--nointeraction"],
      ["get", "totp", "GitHub", "--nointeraction"],
      ["get", "item", "Example API", "--nointeraction"],
      ["get", "item", "build box", "--nointeraction"],
      ["status", "--nointeraction"],
    ]);
    // Nothing of the Gateway's env is inherited; the session is never an argument.
    const allowed = ["BITWARDENCLI_APPDATA_DIR", "BW_NOINTERACTION", "BW_SESSION", "HOME", "PATH"];
    for (const c of calls) {
      expect(c.env.filter((k) => !allowed.includes(k) && !k.startsWith("__CF"))).toEqual([]);
      expect(c.argv.join(" ")).not.toContain(SESSION);
    }
    expect(process.env.BW_SESSION).toBeUndefined();
  });

  it("maps locked, missing and ambiguous items without echoing the CLI or the session", async () => {
    const locked = source("bw_wrong_session_key_000000000000");
    const err = await locked.readField({ item: "GitHub" }, "password").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", details: { reason: "bw_locked" } });
    expect(await locked.unavailableReason()).toBe("bw status is locked");
    const bw = source();
    await expect(bw.readField({ item: "nope" }, "password")).rejects.toMatchObject({
      code: "not_found",
      details: { reason: "bw_not_found" },
    });
    const twin = await bw.readField({ item: "Twin" }, "password").catch((e: unknown) => e);
    expect(twin).toMatchObject({ code: "not_found", details: { reason: "bw_ambiguous" } });
    expect(String((twin as Error).message)).not.toContain("Try getting");
    await expect(bw.readField({ item: "GitHub" }, "notes")).rejects.toMatchObject({
      code: "not_found",
    });
    for (const e of [err, twin])
      assertNoSecrets({ m: String(e), j: JSON.stringify(e) }, "bw error");
  });

  it("never reads card or identity items", async () => {
    await expect(source().readField({ item: "Visa" }, "token")).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "bw_refused_type" },
    });
  });

  it("refuses references that could be read as a flag", () => {
    for (const item of ["", "-h", "--session=x", "a\u0000b", "x".repeat(129)]) {
      expect(() => checkBitwardenRef({ item })).toThrow();
    }
    expect(() => checkBitwardenRef({ item: "0b1c2d3e-0000-4000-8000-000000000001" })).not.toThrow();
  });
});

describe("Bitwarden items in the vault (G11)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness({ overrides: { bitwarden: source() } });
    await h.vault.setup();
  });
  afterEach(() => h.cleanup());

  const link = (
    kind: "login" | "api_key",
    name: string,
    item: string,
    bindings = [{ origin: GH.value }],
  ) => h.vault.linkBitwarden({ kind, name, bindings, ref: { item } });

  it("links by reference, reads the field only after the approval, and masks it", async () => {
    const meta = await link("login", "GitHub (Bitwarden)", "GitHub");
    expect(meta.backend).toBe("bitwarden");
    expect(h.vault.backendOf(meta.id)).toBe("bitwarden");
    expect(fake.calls).toThrow(); // nothing ran yet: no calls file
    assertNoSecrets(await h.vault.list(), "metadata");
    const apr = await approveFill(h, {
      slug: meta.slug,
      target: GH.value,
      selector: "ref_7",
      element: PASSWORD_FIELD,
    });
    const handle = await h.vault.resolve(`{{cred:${meta.slug}}}`, GH, apr, {
      executor: "browser",
      element: PASSWORD_FIELD,
      selector: "ref_7",
    });
    expect(handle.use((v) => v)).toBe(PW);
    expect(fake.calls().map((c) => c.argv.slice(0, 2))).toEqual([["get", "password"]]);
    expect(h.vault.redact(`log: ${PW}`)).toBe("log: •••");
    expect(h.vault.uses(meta.id, 5)[0]).toMatchObject({ outcome: "filled" });
    const audit = JSON.stringify(await h.audit.list());
    expect(audit).toContain('"backend":"bitwarden"');
    assertNoSecrets(await h.audit.list(), "audit");
  });

  it("is read-only: no secret edits, no moving it into the vault or keychain", async () => {
    const meta = await link("login", "GitHub (Bitwarden)", "GitHub");
    await expect(
      h.vault.update(meta.id, { secret: { password: "new-pw-value-123" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.vault.setBackend(meta.id, "keychain")).rejects.toMatchObject({
      code: "forbidden",
    });
    const renamed = await h.vault.update(meta.id, { name: "GitHub (work)" });
    expect(renamed.name).toBe("GitHub (work)");
  });

  it("refuses a card number held in the item before filling it", async () => {
    const meta = await link("api_key", "Billing", "Billing API", [{ origin: API.value }]);
    const apr = await approveFill(h, {
      slug: meta.slug,
      target: API.value,
      executor: "connector",
    });
    await expect(h.vault.resolve(`{{cred:${meta.slug}}}`, API, apr)).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "refused_data" },
    });
    expect(h.vault.uses(meta.id, 5)[0]).toMatchObject({
      outcome: "failed",
      reason: "refused_data",
    });
  });

  it("links through vault.linkExternal and answers unavailable without a source", async () => {
    const handlers = createVaultHandlers(h.vault);
    const { credential } = await handlers["vault.linkExternal"]({
      source: "bitwarden",
      kind: "api_key",
      name: "Example API",
      bindings: [{ origin: API.value }],
      ref: { item: "Example API" },
    });
    expect(credential.backend).toBe("bitwarden");
    const bare = makeHarness();
    await bare.vault.setup();
    await expect(
      bare.vault.linkBitwarden({ kind: "login", name: "n", bindings: [], ref: { item: "GitHub" } }),
    ).rejects.toMatchObject({ code: "unavailable" });
    bare.cleanup();
  });
});
