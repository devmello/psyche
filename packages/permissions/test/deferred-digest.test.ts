import { SqliteReceiptStore } from "@psyche/audit";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import type { PolicyApprovalInput, PolicyCall, PolicyContext } from "../src/index.ts";
import { riskClassFor, routineWritePath } from "../src/risk.ts";
import {
  CTX,
  call,
  DEVICE,
  type Harness,
  makeBroker,
  memoryDb,
  path,
  sqliteBroker,
} from "./helpers.ts";

const HOME = "/Users/owner";
const REPO = `${HOME}/src/app`;

/** Review rounds 1 and 2: every path here must be sensitive (files that run later, or unknown). */
const MUST_BE_SENSITIVE = [
  // Round 1.
  `${REPO}/.envrc`,
  `${REPO}/Makefile`,
  `${REPO}/package.json`,
  `${REPO}/.vscode/tasks.json`,
  `${REPO}/.github/workflows/ci.yml`,
  `${REPO}/.husky/pre-commit`,
  `${HOME}/.zshrc`,
  `${HOME}/.bash_profile`,
  `${HOME}/.config/fish/config.fish`,
  `${HOME}/Library/LaunchAgents/com.example.agent.plist`,
  `${REPO}/rules.mk`,
  `${REPO}/pyproject.toml`,
  `${REPO}/setup.py`,
  `${REPO}/.npmrc`,
  `${REPO}/.ENVRC`,
  `${REPO}/MaKefile`,
  // Round 2: Claude Code and MCP.
  `${REPO}/.claude/settings.json`,
  `${REPO}/.claude/hooks/stop.sh`,
  `${REPO}/.claude/commands/ship.md`,
  `${REPO}/.mcp.json`,
  `${REPO}/CLAUDE.md`,
  `${REPO}/AGENTS.md`,
  // Git and editor config, PATH.
  `${HOME}/.config/git/config`,
  `${HOME}/.local/bin/git`,
  `${HOME}/bin/git`,
  `${HOME}/.config/nvim/init.lua`,
  `${HOME}/.oh-my-zsh/custom/x.zsh`,
  `${HOME}/.config/starship.toml`,
  `${HOME}/.tmux.conf`,
  `${HOME}/.vimrc`,
  // Packages and environments.
  `${REPO}/node_modules/.bin/vitest`,
  `${REPO}/node_modules/left-pad/index.js`,
  `${REPO}/node_modules/left-pad/package.json`,
  `${REPO}/node_modules/left-pad/README.md`,
  `${REPO}/.venv/lib/python3.12/site-packages/x.pth`,
  `${REPO}/venv/bin/activate`,
  `${REPO}/env/lib/python3.12/site-packages/notes.md`,
  `${REPO}/.pnpmfile.cjs`,
  // Hooks and task runners.
  `${REPO}/.githooks/pre-commit`,
  `${REPO}/githooks/pre-commit.md`,
  `${REPO}/hooks/notes.md`,
  `${REPO}/lefthook.yml`,
  `${REPO}/mise.toml`,
  `${REPO}/.mise.toml`,
  `${REPO}/.cargo/config.toml`,
  `${REPO}/vite.config.ts`,
  `${REPO}/vitest.config.json`,
  `${REPO}/conftest.py`,
  `${REPO}/Dockerfile`,
  `${REPO}/Dockerfile.md`,
  `${REPO}/.justfile`,
  `${REPO}/justfile`,
  `${REPO}/.devcontainer/devcontainer.json`,
  `${REPO}/app.code-workspace`,
  `${REPO}/Gemfile`,
  `${REPO}/.tool-versions`,
  `${REPO}/docker-compose.yml`,
  `${REPO}/compose.yaml`,
  `${REPO}/.gitlab-ci.yml`,
  `${REPO}/azure-pipelines.yml`,
  `${REPO}/action.yml`,
  `${REPO}/workflows/build.yml`,
  `${REPO}/tsconfig.json`,
  `${REPO}/tsconfig.base.json`,
  `${REPO}/babelrc.json`,
  `${REPO}/deno.json`,
  `${REPO}/composer.json`,
  // Code and unknown types.
  `${REPO}/src/index.ts`,
  `${REPO}/scripts/run.sh`,
  `${REPO}/notes`,
  `${HOME}/Notes/run.command`,
  // Round 3: JSON and YAML are never routine (tool configs with commands in them).
  `${REPO}/lefthook.json`,
  `${REPO}/devbox.json`,
  `${REPO}/simple-git-hooks.json`,
  `${REPO}/importmap.json`,
  `${REPO}/import_map.json`,
  `${REPO}/cdk.json`,
  `${REPO}/nodemon.json`,
  `${REPO}/wrangler.json`,
  `${REPO}/cypress.json`,
  `${REPO}/workspace.json`,
  `${REPO}/pnpm-workspace.yaml`,
  `${REPO}/environment.yml`,
  `${REPO}/electron-builder.yml`,
  `${REPO}/data/people.json`,
  `${REPO}/data/inventory.yaml`,
  // pip requirement and constraint files.
  `${REPO}/requirements.txt`,
  `${REPO}/requirements-dev.txt`,
  `${REPO}/requirements/base.txt`,
  `${REPO}/dev-requirements.txt`,
  `${REPO}/test_constraints.txt`,
  `${REPO}/reqs/base.txt`,
  `${REPO}/constraints.txt`,
  `${REPO}/deps.pip`,
  `${HOME}/pip.conf`,
  // Agent instruction files and folders.
  `${REPO}/AGENT.md`,
  `${REPO}/CONVENTIONS.md`,
  `${REPO}/docs/SKILL.md`,
  `${REPO}/skills/release/SKILL.md`,
  `${REPO}/skills/notes.md`,
  `${REPO}/prompts/review.md`,
  `${REPO}/.github/copilot-instructions.md`,
  `${REPO}/docs/copilot-instructions.md`,
  `${REPO}/GEMINI.md`,
  // `.gitattributes` points files at the owner's filter, diff and merge drivers.
  `${REPO}/.gitattributes`,
  // macOS bundles.
  `${HOME}/Applications/Tool.app/Contents/MacOS/notes.md`,
  `${HOME}/Notes/Thing.bundle/readme.md`,
  `${REPO}/Kit.framework/notes.md`,
  `${HOME}/Notes/Fx.plugin/notes.md`,
  `${HOME}/Notes/Drv.kext/notes.md`,
  // Unicode that APFS folds onto the real file (U+017F long s), and other non-ASCII.
  `${REPO}/ſetup.py`,
  `${REPO}/package.jſon`,
  `${HOME}/.zſhrc`,
  `${HOME}/.baſhrc`,
  `${REPO}/juſtfile`,
  `${HOME}/Notes/ſummary.md`,
  `${HOME}/Notes/café.md`,
  `${HOME}/Notes/ﬁle.md`,
];

/** Documents and data that may be bulk-approved. */
const MAY_BE_ROUTINE = [
  `${HOME}/Notes/weekly.md`,
  `${HOME}/notes/today.md`,
  `${REPO}/data/report.csv`,
  `${REPO}/docs/img/chart.png`,
  `${REPO}/docs/guide.rst`,
  `${HOME}/Notes/Makefile notes.md`,
  `${REPO}/docs/package.md`,
  `${HOME}/Notes/vscode/tasks.md`,
  `${HOME}/Notes/report.txt`,
  `${REPO}/data/rows.tsv`,
  `${REPO}/notes/reqs-meeting.md`,
  `${REPO}/docs/build.log`,
  `${HOME}/Documents/slides.pptx`,
  `${HOME}/Documents/Report.PDF`,
  `${REPO}/.gitignore`,
  `${REPO}/.editorconfig`,
];

// The risk class comes from the broker's own `decide` (its rule), driven for real here: the card
// is routine only for a plain mode-default write ask. Each row is a near-miss that must not be.

// Manual mode asks for every write, so a write in a granted folder reaches the mode default.
const UNATTENDED: PolicyContext = {
  ...CTX,
  runId: "run_auto",
  permissionMode: "manual",
  unattended: true,
};
const FOLDERS = [{ path: "/Users/owner", mode: "rw" as const }];
/** A broker with the owner's home granted read-write (so file writes are not denied). */
const mk = (options: Parameters<typeof makeBroker>[0] = {}) =>
  makeBroker({ ...options, policy: { folders: FOLDERS, ...(options.policy ?? {}) } });
const NOTES = "/Users/owner/Notes/weekly.md";

/** decide → requestApproval as the agent loop does for an unattended run. */
async function issue(
  h: Harness,
  c: PolicyCall,
  ctx: PolicyContext = UNATTENDED,
  extra: Partial<PolicyApprovalInput> = {},
) {
  const d = await h.broker.decide(c, ctx);
  if (d.decision !== "ask" || d.approvalKind === undefined || d.bindingHash === undefined) {
    throw new Error(`expected ask, got ${d.decision} (${d.rule})`);
  }
  const issued = await h.broker.requestApproval({
    kind: d.approvalKind,
    summary: `test ${c.tool}`,
    details: {},
    bindingHash: d.bindingHash,
    grantKey: d.grantKey ?? "k",
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces: ["desktop"],
    taint: ctx.taint,
    setAside: true,
    ...extra,
  });
  return { d, issued };
}

const write = (p: string, extra: Partial<PolicyCall> = {}) =>
  call("write_file", "write", path(p), extra);

describe("riskClass from the decision that asked (real decide)", () => {
  it("positive control: a plain mode-default file write is routine", async () => {
    const h = mk();
    const { d, issued } = await issue(h, write(NOTES));
    expect(d.rule).toBe("mode:manual/write");
    expect(issued.approval.riskClass).toBe("routine");
    expect(issued.approval.setAside).toBe(true);
  });

  const git = (params: Record<string, unknown>) =>
    call("code.git", "write", path("/Users/owner/src/app"), { kind: "git_write", params });

  it("positive control: a commit of explicit document files, and a new branch, are routine", async () => {
    const h = mk();
    const commit = git({ op: "commit", message: "Notes", paths: ["notes/today.md", "data/r.csv"] });
    const { d, issued } = await issue(h, commit);
    expect(d.rule).toBe("mode:manual/write");
    expect(issued.approval.riskClass).toBe("routine");
    const branch = git({ op: "branch", name: "notes", create: true });
    expect((await issue(h, branch)).issued.approval.riskClass).toBe("routine");
  });

  it.each([
    ["no paths (git's default: everything)", { op: "commit", message: "m" }],
    ['"." (the owner\'s unfinished work too)', { op: "commit", message: "m", paths: ["."] }],
    ["a folder", { op: "commit", message: "m", paths: ["notes"] }],
    ["a folder with a slash", { op: "commit", message: "m", paths: ["notes/"] }],
    ["a file that runs later", { op: "commit", message: "m", paths: ["notes/a.md", "Makefile"] }],
    ["a path out of the repo", { op: "commit", message: "m", paths: ["../x.md"] }],
    ["pathspec magic :!", { op: "commit", message: "m", paths: [":!notes.md"] }],
    ["pathspec magic :(exclude)", { op: "commit", message: "m", paths: [":(exclude)notes.md"] }],
    ["a glob *", { op: "commit", message: "m", paths: ["*.md"] }],
    ["a glob ?", { op: "commit", message: "m", paths: ["note?.md"] }],
    ["a glob []", { op: "commit", message: "m", paths: ["[n]otes.md"] }],
    ["switching branch (rewrites the tree)", { op: "branch", name: "main" }],
  ])("a git write with %s is sensitive", async (_name, params) => {
    const h = mk();
    expect((await issue(h, git(params))).issued.approval.riskClass).toBe("sensitive");
  });

  it("B1: a write the Auto classifier called sensitive is sensitive", async () => {
    const h = mk();
    const c = write(NOTES);
    // A granted folder puts the write in Auto's classifier step; no owner messages → sensitive.
    const { d, issued } = await issue(h, c, {
      ...UNATTENDED,
      permissionMode: "auto",
      ownerMessages: [],
    });
    expect(d.rule).toBe("classifier:sensitive");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a tainted run's write (taint:*) is sensitive", async () => {
    const h = mk();
    const { d, issued } = await issue(h, write(NOTES), {
      ...UNATTENDED,
      taint: true,
      newTarget: true,
    });
    expect(d.rule.startsWith("taint:")).toBe(true);
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("an owner ask rule (policy:ask:*) is sensitive", async () => {
    const h = mk({ policy: { ask: ["write_file"] } });
    const { d, issued } = await issue(h, write(NOTES));
    expect(d.rule).toBe("policy:ask:write_file");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a destructive call is sensitive", async () => {
    const h = mk();
    const c = call("thread_archive", "destructive", undefined, { kind: "archive_thread" });
    const { d, issued } = await issue(h, c);
    expect(d.rule).toBe("mode:manual/destructive");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a relabelled call (a connector tool claiming file_write) is sensitive", async () => {
    const h = mk();
    const c = call("conn.action", "write", path(NOTES), { kind: "file_write" });
    const { d, issued } = await issue(h, c);
    expect(d.approvalKind).toBe("file_write");
    expect(d.rule).toBe("mode:manual/write");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("git_write from a tool other than code.git is sensitive", async () => {
    const h = mk();
    const c = call("conn.action", "write", path("/Users/owner/src/app"), { kind: "git_write" });
    expect((await issue(h, c)).issued.approval.riskClass).toBe("sensitive");
  });

  it.each(MUST_BE_SENSITIVE)("a write to %s is sensitive (real decide)", async (p) => {
    const h = mk();
    expect((await issue(h, write(p))).issued.approval.riskClass).toBe("sensitive");
  });

  it.each(MAY_BE_ROUTINE)("a write to %s may be routine (real decide)", async (p) => {
    const h = mk();
    expect((await issue(h, write(p))).issued.approval.riskClass).toBe("routine");
  });

  it("a patch (code.edit) is sensitive: its files are not read here", async () => {
    const h = mk();
    const c = call("code.edit", "write", path("/Users/owner/src/app"), {
      params: { root: "/Users/owner/src/app", patch: "--- a/notes.md\n+++ b/notes.md\n" },
    });
    expect((await issue(h, c)).issued.approval.riskClass).toBe("sensitive");
  });

  it("no decision at all (a card issued without decide) is sensitive", async () => {
    const h = mk();
    const issued = await h.broker.requestApproval({
      kind: "file_write",
      summary: "Write notes",
      details: {},
      bindingHash: "sha256:none",
      grantKey: "k",
      requestedBy: { runId: "run_auto", taskId: "task_1", threadId: "thr_main" },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("another run's decision under the same binding does not count", async () => {
    const h = mk();
    const c = write(NOTES);
    const { issued } = await issue(h, c, UNATTENDED, {
      requestedBy: { runId: "run_other", taskId: "task_1", threadId: "thr_main" },
    });
    expect(issued.approval.riskClass).toBe("sensitive");
    expect(issued.approval.setAside).toBeUndefined();
  });

  it("a device-only card is sensitive", async () => {
    const h = mk();
    const { issued } = await issue(h, write(NOTES), UNATTENDED, { deviceOnly: true });
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a non-owner requester makes it sensitive (unit, same decision otherwise routine)", () => {
    const base = {
      kind: "file_write" as const,
      sideEffect: "write" as const,
      requiresAuthentication: false,
      taint: false,
      deviceOnly: false,
      typedConfirmation: false,
    };
    const recent = (ctx: PolicyContext) => ({
      call: write(NOTES),
      ctx,
      decision: {
        decision: "ask" as const,
        rule: "mode:manual/write",
        approvalKind: "file_write" as const,
        sideEffect: "write" as const,
        trace: [],
        call: write(NOTES),
      },
      fields: {},
    });
    expect(riskClassFor({ ...base, recent: recent(UNATTENDED) })).toBe("routine");
    expect(
      riskClassFor({
        ...base,
        recent: recent({ ...UNATTENDED, requester: { role: "designated", identityId: "idn_1" } }),
      }),
    ).toBe("sensitive");
    expect(riskClassFor({ ...base, typedConfirmation: true, recent: recent(UNATTENDED) })).toBe(
      "sensitive",
    );
    expect(
      riskClassFor({ ...base, requiresAuthentication: true, recent: recent(UNATTENDED) }),
    ).toBe("sensitive");
  });

  it("routineWritePath: an empty or bare path fails closed", () => {
    expect(routineWritePath("")).toBe(false);
    expect(routineWritePath("/")).toBe(false);
    expect(routineWritePath("/Users/owner/Notes")).toBe(false);
  });
});

describe("routineWritePath: the document allowlist (both lists)", () => {
  it.each(MUST_BE_SENSITIVE)("%s is not routine", (p) => {
    expect(routineWritePath(p)).toBe(false);
  });
  it.each(MAY_BE_ROUTINE)("%s is routine", (p) => {
    expect(routineWritePath(p)).toBe(true);
  });
});

const answerAs = (
  h: Harness,
  issued: { approval: { id: string }; answerTokens: Record<string, string> },
  extra: { bulk?: true; scope?: "once" | "task" | "always" } = {},
) =>
  h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: extra.scope ?? "once",
    decidedBy: DEVICE,
    ...(extra.bulk === undefined ? {} : { bulk: extra.bulk }),
  });

describe("bulk answers are checked by the broker", () => {
  it("bulk approves a routine card (positive control) and refuses a sensitive one", async () => {
    const h = mk({ canResume: () => true });
    const routine = await issue(h, write(NOTES));
    const sensitive = await issue(h, write("/Users/owner/.zshrc"));
    h.clock.advance(500);
    expect((await answerAs(h, routine.issued, { bulk: true })).status).toBe("approved");
    await expect(answerAs(h, sensitive.issued, { bulk: true })).rejects.toMatchObject({
      code: "invalid_params",
      details: { reason: "not_routine" },
    });
    // Its own tap still works: bulk is refused, the card is not.
    expect((await answerAs(h, sensitive.issued)).status).toBe("approved");
  });

  it("a refused bulk answer never counts toward the owner's lockout", async () => {
    const h = mk({ canResume: () => true });
    const r = await issue(h, write("/Users/owner/src/app/Makefile"));
    h.clock.advance(500);
    for (let i = 0; i < 80; i++) {
      await expect(answerAs(h, r.issued, { bulk: true })).rejects.toMatchObject({
        details: { reason: "not_routine" },
      });
    }
    expect((await answerAs(h, r.issued)).status).toBe("approved");
  });
});

describe("the Gateway's SQLite store keeps the class and the set-aside mark", () => {
  it("a routine set-aside card reads back as routine and set aside (and is gated as such)", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const h = {
      broker: sqliteBroker(db, clock, { policy: { folders: FOLDERS } }),
      clock,
    } as unknown as Harness;
    const routine = await issue(h, write(NOTES));
    const sensitive = await issue(h, write(`${REPO}/Makefile`));
    expect(await h.broker.get(routine.issued.approval.id)).toMatchObject({
      riskClass: "routine",
      setAside: true,
    });
    expect((await h.broker.get(sensitive.issued.approval.id))?.riskClass).toBe("sensitive");
    // No `canResume` here: the stored mark still makes Approve refuse, as it must.
    clock.advance(500);
    await expect(answerAs(h, routine.issued)).rejects.toMatchObject({
      details: { reason: "not_resumable" },
    });
  });
});

describe("a restart reports every set-aside approval whose resume it cut short, once", () => {
  /** Runs of the card's automation: the run that set it aside and its resume run. */
  const RUNS = new Set([UNATTENDED.taskId, "task_resume"]);

  async function approved(
    scope: "once" | "always" | "task",
    opt: { sameAutomation?: boolean } = {},
  ) {
    const db = memoryDb();
    const clock = new FakeClock();
    const options = {
      policy: { folders: FOLDERS },
      canResume: () => true,
      ...(opt.sameAutomation === false
        ? {}
        : {
            sameAutomation: (a: ApprovalRequest, taskId: string) =>
              RUNS.has(a.requestedBy.taskId ?? "") && RUNS.has(taskId),
          }),
    };
    const h = { broker: sqliteBroker(db, clock, options), clock } as unknown as Harness;
    // Balanced mode with no path: the plain mode default offers standing scopes too.
    const c = call("conn.action", "write");
    const { issued } = await issue(h, c, { ...UNATTENDED, permissionMode: "balanced" });
    clock.advance(500);
    expect((await answerAs(h, issued, { scope })).status).toBe("approved");
    const restart = async () => {
      const seen: string[] = [];
      const failed: boolean[] = [];
      const unknown: boolean[] = [];
      const b = sqliteBroker(db, clock, {
        ...options,
        onSetAsideRevoked: (a, how) => {
          seen.push(a.id);
          failed.push(how.failed);
          unknown.push(how.unknown);
        },
      });
      await b.reissue();
      return { b, seen, failed, unknown };
    };
    return { h, issued, restart };
  }

  it.each(["always", "task"] as const)("a %s approval gets the notice too", async (scope) => {
    const { issued, restart } = await approved(scope);
    expect((await restart()).seen).toEqual([issued.approval.id]);
    // Reported once: the next restart has nothing more to say.
    expect((await restart()).seen).toEqual([]);
  });

  it("a once approval gets the notice and is revoked", async () => {
    const { issued, restart } = await approved("once");
    const { b, seen } = await restart();
    expect(seen).toEqual([issued.approval.id]);
    expect((await b.verifyBinding(issued.approval.id, issued.approval.bindingHash)).ok).toBe(false);
  });

  it("an action that ran and failed is not done: reported, as failed", async () => {
    const { h, issued, restart } = await approved("always");
    await h.broker.recordReceipt({
      kind: "connector_action",
      outcome: "failed",
      summary: "failed",
      approvalId: issued.approval.id,
    });
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
    expect(r.failed).toEqual([true]);
  });

  it("positive control: an action that succeeded (an ok receipt) is not reported", async () => {
    const { h, issued, restart } = await approved("always");
    await h.broker.recordReceipt({
      kind: "connector_action",
      outcome: "ok",
      summary: "ok",
      approvalId: issued.approval.id,
    });
    expect((await restart()).seen).toEqual([]);
  });

  /**
   * A call through the `always` grant, as a run makes it: by default the card's own call in a
   * run of its automation (`task_resume`); `params` makes it another action under the grant.
   */
  async function throughGrant(
    h: Harness,
    opts: { taskId?: string; params?: Record<string, unknown> } = {},
  ) {
    const d = await h.broker.decide(
      call(
        "conn.action",
        "write",
        undefined,
        opts.params === undefined ? {} : { params: opts.params },
      ),
      {
        ...UNATTENDED,
        runId: "run_resume",
        taskId: opts.taskId ?? "task_resume",
        permissionMode: "balanced",
      },
    );
    expect(d.decision).toBe("allow");
    expect(d.grantId).toBeDefined();
    return { id: d.grantId as string, bindingHash: d.bindingHash as string };
  }

  /**
   * A connector receipt as ConnectorRegistry writes it: its action as kind, its task, and the
   * grant's id and the call's binding in its payload.
   */
  const connectorReceipt = (
    h: Harness,
    outcome: "ok" | "failed" | "uncertain",
    grant: { id: string; bindingHash: string } | undefined,
    taskId = "task_resume",
  ) =>
    h.broker.recordReceipt({
      kind: "gmail.send",
      outcome,
      summary: outcome,
      taskId,
      approvalId: null,
      payload:
        grant === undefined
          ? { rule: "mode:auto/write" }
          : { rule: `grant:${grant.id}`, grantId: grant.id, bindingHash: grant.bindingHash },
    });

  it("a use of its grant whose call failed is not done: reported, as failed", async () => {
    const { h, issued, restart } = await approved("always");
    await connectorReceipt(h, "failed", await throughGrant(h));
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
    expect(r.failed).toEqual([true]);
    expect(r.unknown).toEqual([false]);
  });

  it("a use of its grant with no receipt is not done: reported, outcome unknown", async () => {
    const { h, issued, restart } = await approved("always");
    await throughGrant(h);
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
    expect(r.failed).toEqual([false]);
    expect(r.unknown).toEqual([true]);
  });

  it("an unrelated ok receipt of the same kind (another grant, or none) does not make it done", async () => {
    const { h, issued, restart } = await approved("always");
    const g = await throughGrant(h);
    await connectorReceipt(h, "ok", undefined);
    await connectorReceipt(h, "ok", { ...g, id: "grt_someone_else" });
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
    expect(r.unknown).toEqual([true]);
  });

  it("an attended chat send through the same grant does not make it done", async () => {
    const { h, issued, restart } = await approved("always");
    // Not a run of the card's automation: its ok receipt says nothing about the card.
    await connectorReceipt(h, "ok", await throughGrant(h, { taskId: "task_chat" }), "task_chat");
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
  });

  it("another action through the grant in the automation's run does not make it done", async () => {
    const { h, issued, restart } = await approved("always");
    const other = await throughGrant(h, { params: { other: true } });
    expect(other.bindingHash).not.toBe(issued.approval.bindingHash);
    await connectorReceipt(h, "ok", other);
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
    // Its own action never ran through the grant: not reached, not "unknown" and not failed.
    expect(r.failed).toEqual([false]);
    expect(r.unknown).toEqual([false]);
  });

  it("without the automation check (no sameAutomation) no grant receipt counts: fails closed", async () => {
    const { h, issued, restart } = await approved("always", { sameAutomation: false });
    await connectorReceipt(h, "ok", await throughGrant(h));
    expect((await restart()).seen).toEqual([issued.approval.id]);
  });

  it("an uncertain receipt for its grant's call: reported, outcome unknown", async () => {
    const { h, issued, restart } = await approved("always");
    await connectorReceipt(h, "uncertain", await throughGrant(h));
    const r = await restart();
    expect(r.seen).toEqual([issued.approval.id]);
    expect(r.unknown).toEqual([true]);
  });

  it("positive control: an ok receipt for its own call in its automation's run is done", async () => {
    const { h, restart } = await approved("always");
    await connectorReceipt(h, "ok", await throughGrant(h));
    expect((await restart()).seen).toEqual([]);
  });

  it("positive control: the loop's receipt (payload.grantId and bindingHash) is done", async () => {
    const { h, restart } = await approved("always");
    const g = await throughGrant(h);
    await h.broker.recordReceipt({
      kind: "connector_action",
      outcome: "ok",
      summary: "ok",
      taskId: "task_resume",
      approvalId: null,
      payload: { grantId: g.id, bindingHash: g.bindingHash },
    });
    expect((await restart()).seen).toEqual([]);
  });

  it("a card found done at boot is settled: the next boot does not scan for it again", async () => {
    const { h, issued, restart } = await approved("always");
    await connectorReceipt(h, "ok", await throughGrant(h));
    const first = await restart();
    expect(first.seen).toEqual([]);
    // Settled: its own authority ended (the standing grant it made stays).
    expect((await first.b.get(issued.approval.id))?.status).toBe("approved");
    const query = vi.spyOn(SqliteReceiptStore.prototype, "query");
    try {
      const second = await restart();
      expect(second.seen).toEqual([]);
      // No candidate is left, so no `since` query at all.
      expect(query.mock.calls.filter(([f]) => f.since !== undefined)).toEqual([]);
    } finally {
      query.mockRestore();
    }
    expect((await first.b.listGrants()).some((g) => g.revokedAt == null)).toBe(true);
  });

  it("positive control: a card not found done stays a candidate until it is reported", async () => {
    const { h, issued, restart } = await approved("always");
    await throughGrant(h);
    expect((await restart()).seen).toEqual([issued.approval.id]);
    // Reported once, and settled with it: nothing more on the next boot.
    expect((await restart()).seen).toEqual([]);
  });

  it("the boot check reads the receipts once per boot, from the grants' creation on", async () => {
    const one = await approved("always");
    await throughGrant(one.h);
    const query = vi.spyOn(SqliteReceiptStore.prototype, "query");
    try {
      await one.restart();
      const filters = query.mock.calls.map(([f]) => f);
      // Never a scan of every receipt; one `since` query for the grants, whatever the cards.
      expect(filters.filter((f) => Object.keys(f).length === 0)).toEqual([]);
      expect(filters.filter((f) => f.since !== undefined)).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
  });

  it("positive control: a resume that is over (settled) is not reported", async () => {
    const { h, issued, restart } = await approved("always");
    h.broker.settleSetAside(issued.approval.id);
    expect((await restart()).seen).toEqual([]);
  });
});

describe("the decision is announced when the answer is stored", () => {
  it("approval.decided comes before the answer's audit rows and the grant's own events", async () => {
    const h = mk({ canResume: () => true });
    const { issued } = await issue(h, call("conn.action", "write"), {
      ...UNATTENDED,
      permissionMode: "balanced",
    });
    h.clock.advance(500);
    const order: string[] = [];
    h.broker.subscribe((e) => {
      if (e.type === "approval.decided" || e.type === "grant.created") order.push(e.type);
      if (e.type === "approval.decided") {
        // Nothing is audited yet for this decision: no subscriber may rely on it.
        const audited = [...h.audit.store.entries()].some(
          (x) => x.ok && x.entry.kind === "approval.decided",
        );
        order.push(`audited:${audited}`);
      }
    });
    const waiting = h.broker.awaitDecision(issued.approval.id);
    expect((await answerAs(h, issued, { scope: "always" })).status).toBe("approved");
    expect(order).toEqual(["approval.decided", "audited:false", "grant.created"]);
    // Waiters still resolve, once everything is done.
    expect((await waiting).status).toBe("approved");
  });

  it("a use of a set-aside card's grant says so; an attended card's grant does not", async () => {
    const h = mk({ canResume: () => true });
    const used: (true | undefined)[] = [];
    h.broker.subscribe((e) => {
      if (e.type === "grant.used") used.push(e.fromSetAside);
    });
    const ctx = { ...UNATTENDED, permissionMode: "balanced" as const };
    const set = await issue(h, call("conn.action", "write"), ctx);
    h.clock.advance(500);
    await answerAs(h, set.issued, { scope: "always" });
    expect((await h.broker.decide(call("conn.action", "write"), ctx)).decision).toBe("allow");
    const chat = { ...CTX, permissionMode: "balanced" as const };
    const attended = await issue(h, call("other.action", "write"), chat, { setAside: undefined });
    expect(attended.issued.approval.setAside).toBeUndefined();
    h.clock.advance(500);
    await answerAs(h, attended.issued, { scope: "always" });
    expect((await h.broker.decide(call("other.action", "write"), chat)).decision).toBe("allow");
    expect(used).toEqual([true, undefined]);
  });
});

describe("set-aside cards", () => {
  it("are approved only when a resume run can start (fails closed without one)", async () => {
    const none = mk();
    const a = await issue(none, write(NOTES));
    none.clock.advance(500);
    await expect(answerAs(none, a.issued)).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "not_resumable" },
    });
    expect((await none.broker.get(a.issued.approval.id))?.status).toBe("pending");

    const yes = mk({ canResume: (x) => x.setAside === true });
    const b = await issue(yes, write(NOTES));
    yes.clock.advance(500);
    expect((await answerAs(yes, b.issued)).status).toBe("approved");
  });

  it("a caller that awaits its card (webhook delivery) is never set aside", async () => {
    const h = mk();
    const { issued } = await issue(h, write(NOTES), UNATTENDED, { setAside: undefined });
    expect(issued.approval.setAside).toBeUndefined();
    const waiting = h.broker.awaitDecision(issued.approval.id);
    h.clock.advance(500);
    expect((await answerAs(h, issued)).status).toBe("approved");
    expect((await waiting).status).toBe("approved");
  });

  it("an attended run's ask is never set aside, even when the loop flag is sent", async () => {
    const h = mk();
    const { issued } = await issue(h, write(NOTES), { ...CTX, permissionMode: "manual" });
    expect(issued.approval.setAside).toBeUndefined();
  });
});

describe("automation digest in the broker", () => {
  it("a deferred card gets no notice of its own; an owner's card still does", async () => {
    const h = mk({ deferredApproval: (a) => a.requestedBy.runId === "run_auto" });
    await issue(h, write(NOTES));
    expect(await h.notifier.list({ unresolvedOnly: true })).toHaveLength(0);
    await issue(h, write("/Users/owner/Notes/other.md"), { ...CTX, permissionMode: "manual" });
    expect(await h.notifier.list({ unresolvedOnly: true })).toHaveLength(1);
  });

  it("an expired deferred card cannot be approved late", async () => {
    const h = mk({ canResume: () => true });
    const { issued } = await issue(h, write(NOTES));
    h.clock.advance(30 * 60_000);
    await expect(answerAs(h, issued)).rejects.toThrow();
  });
});
