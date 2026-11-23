import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeMemoryGit } from "../src/compose/memory-git.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, remoteClient, type TestClient } from "./helpers.ts";

/**
 * `memory.gitSync.*` on the composed Gateway, against a bare repository on this disk (never the
 * network, never the owner's `~/.psyche`). Admin only for set and run.
 */

let composed: ComposedGateway | null = null;
let root = "";
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** The error code of a refused call (the client types `error` loosely). */
const codeOf = (res: { error?: unknown }): string | undefined =>
  (res.error as { code?: string } | undefined)?.code;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Remote", "-c", "user.email=remote@test", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

interface Result {
  ok: boolean;
  committed: boolean;
  files: number;
  pushed: boolean;
  conflicts?: string[];
  blocked?: string[];
  errorCode?: string;
}

async function setup(): Promise<{ gw: ComposedGateway; home: string; bare: string }> {
  root = mkdtempSync(join(tmpdir(), "psyche-gitsync-"));
  const home = join(root, "home");
  mkdirSync(join(home, "workspace"), { recursive: true });
  const bare = join(root, "remote.git");
  git(root, ["init", "-q", "--bare", "-b", "main", bare]);
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [(s) => composeMemoryGit(s)],
  });
  writeFileSync(join(home, "workspace", "MEMORY.md"), "# Memory\n");
  return { gw: composed, home, bare };
}

describe("memory.gitSync.* on the running Gateway", () => {
  it("validates the remote, syncs to the bare repository and reports what happened", async () => {
    const { gw, home, bare } = await setup();
    const admin = await adminClient(gw.gateway);
    clients.push(admin);

    const initial = await admin.call<{ config: { enabled: boolean }; last: unknown }>(
      "memory.gitSync.get",
      {},
    );
    expect(initial.config.enabled).toBe(false);
    expect(initial.last).toBeNull();

    // Refused: a password in the URL, and enabling without a remote.
    const withPassword = await admin.request(
      "memory.gitSync.set",
      {
        remote: ["https://owner", "hunter2@example.com/memory.git"].join(":"),
        branch: "main",
        enabled: false,
      },
      ik(),
    );
    expect(withPassword.ok).toBe(false);
    expect(codeOf(withPassword)).toBe("invalid_params");
    const noRemote = await admin.request(
      "memory.gitSync.set",
      { remote: "", branch: "main", enabled: true },
      ik(),
    );
    expect(codeOf(noRemote)).toBe("invalid_params");

    const saved = await admin.call<{ remote: string; enabled: boolean }>(
      "memory.gitSync.set",
      { remote: bare, branch: "main", enabled: true },
      ik(),
    );
    expect(saved).toMatchObject({ remote: bare, enabled: true });

    const first = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(first).toMatchObject({ ok: true, committed: true, pushed: true });
    expect(first.files).toBeGreaterThan(0);
    const remoteLog = git(bare, ["log", "--oneline", "main"]);
    expect(remoteLog).toContain("Psyche memory sync");

    const after = await admin.call<{ last: Result }>("memory.gitSync.get", {}, ik());
    expect(after.last).toMatchObject({ ok: true, pushed: true });

    // The sync wrote .gitignore next to the notes; it is part of the backup.
    expect(readFileSync(join(home, "workspace", ".gitignore"), "utf8")).toContain(
      "memory/imports/",
    );
  }, 60_000);

  it("refuses to push a file that holds a credential, and names it", async () => {
    const { gw, home, bare } = await setup();
    const admin = await adminClient(gw.gateway);
    clients.push(admin);
    await admin.call("memory.gitSync.set", { remote: bare, branch: "main", enabled: true }, ik());

    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    writeFileSync(
      join(home, "workspace", "memory", "keys.md"),
      `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nMIIEvQIBADANBgkqhkiG\n${["-----END", "PRIVATE KEY-----"].join(" ")}\n`,
    );
    const blocked = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(blocked.ok).toBe(false);
    expect(blocked.errorCode).toBe("blocked_secret");
    expect(blocked.blocked).toEqual(["memory/keys.md"]);
    expect(blocked.pushed).toBe(false);
    // Nothing reached the remote: only the empty repository exists.
    expect(() => git(bare, ["rev-parse", "--verify", "-q", "main"])).toThrow();
  }, 60_000);

  it("reports a conflict with the remote, aborts the rebase and pushes nothing", async () => {
    const { gw, home, bare } = await setup();
    const admin = await adminClient(gw.gateway);
    clients.push(admin);
    await admin.call("memory.gitSync.set", { remote: bare, branch: "main", enabled: true }, ik());
    // Base: the first sync pushes MEMORY.md.
    const base = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(base.ok).toBe(true);

    // Another machine pushes a different MEMORY.md to the same branch.
    const other = join(root, "other");
    git(root, ["clone", "-q", bare, other]);
    writeFileSync(join(other, "MEMORY.md"), "# Remote edit\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "remote edit"]);
    git(other, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    // This Mac edits the same line and syncs.
    writeFileSync(join(home, "workspace", "MEMORY.md"), "# Local edit\n");
    const conflict = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe("conflict");
    expect(conflict.conflicts).toContain("MEMORY.md");
    expect(conflict.pushed).toBe(false);
    expect(git(bare, ["show", "main:MEMORY.md"])).toBe("# Remote edit\n");
  }, 60_000);

  it("runs nothing while disabled, and refuses set and run without admin", async () => {
    const { gw, bare } = await setup();
    const admin = await adminClient(gw.gateway);
    clients.push(admin);
    await admin.call("memory.gitSync.set", { remote: bare, branch: "main", enabled: false }, ik());
    const off = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(off.ok).toBe(false);
    expect(off.errorCode).toBe("not_enabled");

    // A paired device without the admin scope: reads are fine, changes are refused.
    const phone = await remoteClient(gw.gateway);
    clients.push(phone);
    const read = await phone.request("memory.gitSync.get", {}, ik());
    expect(read.ok).toBe(true);
    const setRes = await phone.request(
      "memory.gitSync.set",
      { remote: bare, branch: "main", enabled: true },
      ik(),
    );
    expect(setRes.ok).toBe(false);
    expect(codeOf(setRes)).toBe("forbidden");
    const runRes = await phone.request("memory.gitSync.run", {}, ik());
    expect(runRes.ok).toBe(false);
    expect(codeOf(runRes)).toBe("forbidden");
  }, 60_000);

  it("keeps the voice profile and raw imports off the remote, even when a commit tracked them", async () => {
    const { gw, home, bare } = await setup();
    const admin = await adminClient(gw.gateway);
    clients.push(admin);
    await admin.call("memory.gitSync.set", { remote: bare, branch: "main", enabled: true }, ik());
    const workspace = join(home, "workspace");
    mkdirSync(join(workspace, "mail"), { recursive: true });
    mkdirSync(join(workspace, "memory", "imports"), { recursive: true });
    writeFileSync(join(workspace, "mail", "VOICE.md"), "# Voice\n\nHow I write.\n");
    writeFileSync(join(workspace, "mail", "voice-samples.jsonl"), '{"text":"hi"}\n');
    writeFileSync(join(workspace, "memory", "imports", "raw.md"), "# Raw export\n");

    const first = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(first.ok).toBe(true);
    const onRemote = git(bare, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    expect(onRemote).not.toContain("mail/VOICE.md");
    expect(onRemote).not.toContain("mail/voice-samples.jsonl");
    expect(onRemote.some((p) => p.startsWith("memory/imports/"))).toBe(false);

    // A commit made elsewhere (or before the exclusion) tracks the voice profile.
    git(workspace, ["add", "-f", "mail/VOICE.md"]);
    git(workspace, ["commit", "-q", "-m", "track voice"]);
    // The owner also drops the ignore lines: the pathspec step must still keep it out.
    writeFileSync(join(workspace, ".gitignore"), "");
    writeFileSync(join(workspace, "note.md"), "# Note\n\nA normal note.\n");
    const second = await admin.call<Result>("memory.gitSync.run", {}, ik());
    expect(second.ok).toBe(true);
    const after = git(bare, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    expect(after).not.toContain("mail/VOICE.md");
    expect(after).toContain("note.md");
    expect(git(workspace, ["ls-files"]).split("\n")).not.toContain("mail/VOICE.md");
  }, 60_000);
});
