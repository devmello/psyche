import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { createPermissionBroker, EXEC_REVIEW_RULE } from "@psyche/permissions";
import type { ToolCallDescription } from "@psyche/protocol";
import type { CliDriver, CliResult } from "@psyche/sandbox";
import { describe, expect, it, vi } from "vitest";
import { execHostTool, type SrtStatus } from "../src/compose/exec-host.ts";
import { execTool } from "../src/compose/exec-tool.ts";

/**
 * A host command Auto mode's exec reviewer approved (owner's decision 2026-11-23): the Gateway
 * describes the sandbox facts only on macOS, in a git repository, with srt; the run re-checks
 * everything on disk and writes only its repository, never its hooks, git config or launch
 * config. srt is mocked (never run); the driver records what would start.
 */

const mac = process.platform === "darwin";
const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-xr-")));
const home = join(root, "home");
const psycheHome = join(home, ".psyche");
const folder = join(home, "Projects");
const repo = join(folder, "app");
const plain = join(folder, "notes");
for (const d of [join(repo, ".git"), join(repo, "src"), plain, psycheHome]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(join(repo, ".git", "config"), "[core]\n\tbare = false\n");

const broker = createPermissionBroker({
  approvers: { device: async () => undefined, isOwnerSender: async () => false },
  policy: { exec: { execHostEnabled: true }, folders: [{ path: folder, mode: "rw" }] },
});

let started: { file: string; settings?: unknown }[] = [];
let finish: (r: Partial<CliResult>) => void = () => undefined;
const driver: CliDriver = {
  start(file, args) {
    const at = args.indexOf("--settings");
    const settings =
      at === -1 ? undefined : JSON.parse(readFileSync(args[at + 1] as string, "utf8"));
    started.push({ file, settings });
    const done = new Promise<CliResult>((resolve) => {
      finish = (r) =>
        resolve({
          exitCode: 0,
          signal: null,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
          ...r,
        });
    });
    return { pid: 1, done, kill: () => finish({ exitCode: null, signal: "SIGKILL" }) };
  },
  stream: () => {
    throw new Error("not used");
  },
};

const tool = (srt: SrtStatus = { path: "/opt/mock/srt" }) =>
  execHostTool({
    broker,
    vault: { redact: (t) => t },
    folders: () => broker.policy.folders ?? [],
    srt: { resolve: async () => srt },
    home: psycheHome,
    userHome: home,
    driver,
  });

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext => ({
  callId: "call_1",
  threadId: "thr_1",
  runId: "run_1",
  permissionMode: "auto",
  mode: "attended",
  taint: false,
  signal: new AbortController().signal,
  onUpdate: () => undefined,
  ...over,
});

const described = (t: AgentToolRegistration, params: unknown) =>
  (t.describeCall?.(params) ?? {}) as ToolCallDescription & { meta?: Record<string, unknown> };

/** A tool once its first srt lookup has answered (`describeCall` reads the last known state). */
async function ready(t: AgentToolRegistration, params: unknown) {
  described(t, params);
  await new Promise((r) => setTimeout(r, 5));
  return t;
}

async function reviewedRun(t: AgentToolRegistration, params: { argv: string[]; cwd: string }) {
  const desc = described(t, params);
  const out = t.run?.(
    params,
    ctx({
      authority: {
        rule: EXEC_REVIEW_RULE,
        bindingHash: "sha256:x",
        ...(desc.grantKey === undefined ? {} : { grantKey: desc.grantKey }),
      },
    }),
  );
  return out;
}

describe.skipIf(!mac)("exec_host and the exec reviewer (macOS)", () => {
  it("describes the srt sandbox, the real cwd and the repository, only inside a repository", async () => {
    const t = await ready(tool(), { argv: ["make"], cwd: repo });
    expect(described(t, { argv: ["make"], cwd: join(repo, "src") }).meta?.execReview).toEqual({
      sandbox: "srt",
      cwdReal: join(repo, "src"),
      repoRoot: repo,
    });
    // Not a repository, or srt missing: no reviewer facts, so the reviewer never sees it.
    expect(described(t, { argv: ["make"], cwd: plain }).meta?.execReview).toBeUndefined();
    const none = await ready(tool({ missing: true, reason: "no srt" } as never), {
      argv: ["make"],
      cwd: repo,
    });
    expect(described(none, { argv: ["make"], cwd: repo }).meta?.execReview).toBeUndefined();
  });

  it("a reviewed run writes only its repository, never its hooks, git config or launch config", async () => {
    started = [];
    const t = await ready(tool(), { argv: ["make"], cwd: repo });
    const out = reviewedRun(t, { argv: ["make", "-j2"], cwd: repo });
    await vi.waitFor(() => expect(started.length).toBe(1));
    finish({});
    await out;
    expect(started[0]?.file).toBe("/opt/mock/srt");
    const fs = (
      (started[0]?.settings ?? {}) as { filesystem: { allowWrite: string[]; denyWrite: string[] } }
    ).filesystem;
    expect(fs.allowWrite).toContain(repo);
    expect(fs.allowWrite).not.toContain(folder);
    for (const p of [
      join(repo, ".git", "hooks"),
      join(repo, ".git", "config"),
      join(repo, ".git", "info"),
      join(repo, ".vscode"),
      join(repo, ".envrc"),
      join(repo, ".npmrc"),
    ]) {
      expect(fs.denyWrite).toContain(p);
    }
    expect(
      ((started[0]?.settings ?? {}) as { network: { allowedDomains: string[] } }).network,
    ).toMatchObject({ allowedDomains: [] });
  });

  it("a reviewed run that no longer fits is refused before it starts", async () => {
    started = [];
    const t = await ready(tool(), { argv: ["make"], cwd: repo });
    for (const params of [
      // Outside a repository now.
      { argv: ["make"], cwd: plain },
      // An argument the reviewer floor never allows.
      { argv: ["make", "-C", "/etc"], cwd: repo },
      { argv: ["sh", "-c", "make"], cwd: repo },
      { argv: ["git", "push"], cwd: repo },
      // Extra environment or network.
      { argv: ["make"], cwd: repo, env: { CC: "x" } },
      { argv: ["make"], cwd: repo, allowedDomains: ["x.test"] },
    ]) {
      await expect(reviewedRun(t, params as never), JSON.stringify(params)).rejects.toThrow(
        /no longer fits what the reviewer approved/,
      );
    }
    // Without srt a reviewed run never starts (it would be unsandboxed).
    const none = await ready(tool({ missing: true, reason: "no srt" } as never), {
      argv: ["make"],
      cwd: repo,
    });
    await expect(reviewedRun(none, { argv: ["make"], cwd: repo })).rejects.toThrow();
    expect(started).toHaveLength(0);
  });
});

describe("exec (the sandbox container) and the exec reviewer", () => {
  it("names the container sandbox for the broker", () => {
    const t = execTool({
      runner: {} as never,
      vault: {} as never,
      broker: {} as never,
    });
    expect(described(t, { argv: ["pnpm", "test"] }).meta).toEqual({
      execReview: { sandbox: "container" },
    });
  });
});

describe.skipIf(!mac)("exec_host in Full access (#1689 review r1, item 6)", () => {
  const settingsOf = (i: number) =>
    ((started[i]?.settings ?? {}) as { filesystem: { allowWrite: string[]; denyWrite: string[] } })
      .filesystem;
  const runAs = async (authority: ToolRunContext["authority"], approvalId?: string) => {
    started = [];
    const t = await ready(tool(), { argv: ["make"], cwd: plain });
    const out = t.run?.(
      { argv: ["make"], cwd: plain },
      ctx({
        permissionMode: "full",
        ...(authority === undefined ? {} : { authority }),
        ...(approvalId === undefined ? {} : { approvalId }),
      }),
    );
    await vi.waitFor(() => expect(started.length).toBe(1));
    finish({});
    await out;
    return settingsOf(0);
  };

  it("a command Full access ran without a card can't write hooks, .envrc or editor tasks", async () => {
    const fs = await runAs({ rule: "mode:full/destructive", bindingHash: "sha256:x" });
    expect(fs.allowWrite).toContain(folder);
    for (const p of [
      join(folder, ".envrc"),
      join(folder, ".vscode"),
      join(plain, ".envrc"),
      join(plain, ".vscode"),
      join(folder, ".git", "hooks"),
    ]) {
      expect(fs.denyWrite).toContain(p);
    }
    // Any repository below the folder: its `.git` (hooks, config) is never writable.
    expect(fs.denyWrite.some((p) => p.startsWith(`${folder}/*/**/`))).toBe(true);
    expect(fs.denyWrite.some((p) => p.startsWith(`${folder}/**/`))).toBe(true);
  });

  it("control: a command allowed another way (Auto's classifier) keeps its folder's usual rules", async () => {
    const fs = await runAs({ rule: "classifier:allow", bindingHash: "sha256:x" });
    expect(fs.allowWrite).toContain(folder);
    expect(fs.denyWrite).not.toContain(join(folder, ".envrc"));
  });
});
