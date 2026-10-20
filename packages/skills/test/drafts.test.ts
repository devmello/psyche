import { join } from "node:path";
import { PsycheError, type SkillDraft } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type RoutineInput, routineSignature, SkillDrafts } from "../src/drafts.ts";
import { createSkillsHandlers } from "../src/handlers.ts";
import { approve, setup } from "./helpers.ts";

/** Feature T3: drafts from repeated routines, never installed by themselves. */

/** A Luhn-valid test card number, assembled at run time so the repo's secret scan never sees one. */
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const OWNER = `Export this week's invoices for dana@example.com to Finance, card ${CARD}, password hunter2`;

function routine(over: Partial<RoutineInput> = {}): RoutineInput {
  const steps = [
    { tool: "list_dir", sideEffect: "read" as const, params: { path: "/Users/you/Invoices" } },
    {
      tool: "read_file",
      sideEffect: "read" as const,
      params: { path: "/Users/you/Invoices/a.pdf" },
    },
    {
      tool: "read_file",
      sideEffect: "read" as const,
      params: { path: "/Users/you/Invoices/b.pdf" },
    },
    {
      tool: "write_file",
      sideEffect: "write" as const,
      params: { path: "/Users/you/Finance/week.csv", content: "secret-value-xyz" },
    },
    { tool: "search_files", sideEffect: "read" as const, params: { query: "receipt 2026" } },
  ];
  return {
    threadId: "thr_1",
    tools: ["list_dir", "read_file", "write_file", "search_files"],
    runs: [
      { runId: "run_1", ownerText: OWNER, taint: false, steps },
      { runId: "run_2", ownerText: "Same again for this week, thanks", taint: true, steps },
    ],
    ...over,
  };
}

function drafts(
  over: { limits?: { perThreadMs?: number; maxOpen?: number; ttlMs?: number } } = {},
) {
  const t = setup();
  const audit: { kind: string }[] = [];
  const updates: SkillDraft[] = [];
  let ids = 0;
  const d = new SkillDrafts({
    dir: join(t.homeDir, ".drafts"),
    loader: t.loader,
    // Stands in for the Gateway's vault + audit redactors.
    redact: (s) => s.replace("hunter2", "•••").replace(CARD, "[redacted:card]"),
    knownTools: () => ["list_dir", "read_file", "write_file", "search_files"],
    audit: (e) => audit.push(e),
    onUpdate: (x) => updates.push(x),
    now: () => t.clock.now(),
    newId: () => `skd_${++ids}`,
    ...over,
  });
  return { t, d, audit, updates };
}

async function rejects(p: Promise<unknown> | (() => unknown)): Promise<PsycheError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(PsycheError);
    return e as PsycheError;
  }
  throw new Error("expected a rejection");
}

describe("drafting a skill from a routine", () => {
  it("keeps tool and input names, strips values, secrets and personal data", () => {
    const { d, audit, updates } = drafts();
    const draft = d.propose(routine()) as SkillDraft;
    expect(draft).toMatchObject({
      status: "open",
      threadId: "thr_1",
      occurrences: 2,
      tainted: true,
      edited: false,
      signature: routineSignature(["list_dir", "read_file", "write_file", "search_files"]),
    });
    expect(draft.name).toBe("same-week-thanks");
    expect(draft.manifest).toEqual({
      tools: ["list_dir", "read_file", "search_files", "write_file"],
      permissions: ["file_write"],
      prompts: [],
    });
    expect(draft.steps.map((s) => `${s.tool}:${s.summary}`)).toEqual([
      "list_dir:inputs: path",
      "read_file:inputs: path",
      "write_file:inputs: path, content",
      "search_files:inputs: query",
    ]);
    for (const leak of [
      "dana@example.com",
      "4111",
      "hunter2",
      "secret-value-xyz",
      "/Users/you",
      "receipt 2026",
    ])
      expect(draft.text).not.toContain(leak);
    expect(draft.redactions).toBeGreaterThanOrEqual(3);
    expect(draft.text).toContain("1. Call `list_dir` (reads) with inputs path.");
    expect(audit.map((e) => e.kind)).toEqual(["skill.draft.proposed"]);
    expect(updates).toHaveLength(1);
  });

  it("scrubs emails, links and long numbers even without the Gateway's redactors", () => {
    const { t } = drafts();
    const bare = new SkillDrafts({ dir: join(t.homeDir, ".d2"), loader: t.loader });
    expect(
      bare.scrub("mail a@b.co about https://x.test/y and +1 (415) 555-0100 order 123456"),
    ).toEqual({
      text: "mail <email> about <link> and <number> order <number>",
      redactions: 4,
    });
  });

  it("proposes once per routine, once per thread per day, and at most five open", () => {
    const { t, d } = drafts();
    expect(d.propose(routine())).toBeDefined();
    // Same routine again: never twice; the open draft keeps the larger count.
    const three = routine();
    three.runs.push({ ...(three.runs[0] as RoutineInput["runs"][number]), runId: "run_3" });
    expect(d.propose(three)).toBeUndefined();
    expect(d.list("open")[0]?.occurrences).toBe(3);
    // Another routine in the same thread within a day: no.
    expect(
      d.propose(routine({ tools: ["list_dir", "read_file", "search_files"] })),
    ).toBeUndefined();
    t.clock.advance(25 * 60 * 60 * 1000);
    expect(d.propose(routine({ tools: ["list_dir", "read_file", "search_files"] }))).toBeDefined();

    const capped = drafts({ limits: { maxOpen: 1 } });
    expect(capped.d.propose(routine())).toBeDefined();
    expect(
      capped.d.propose(
        routine({ threadId: "thr_2", tools: ["read_file", "write_file", "list_dir"] }),
      ),
    ).toBeUndefined();
  });

  it("a dismissed routine is never proposed again, in any thread; open drafts expire", () => {
    const { t, d, audit } = drafts({ limits: { ttlMs: 60_000 } });
    const first = d.propose(routine()) as SkillDraft;
    expect(d.dismiss(first.id).status).toBe("dismissed");
    expect(d.propose(routine({ threadId: "thr_9" }))).toBeUndefined();
    const other = d.propose(
      routine({ threadId: "thr_9", tools: ["read_file", "write_file", "list_dir"] }),
    );
    expect(other).toBeDefined();
    t.clock.advance(61_000);
    expect(d.list().find((x) => x.id === other?.id)?.status).toBe("expired");
    expect(audit.map((e) => e.kind)).toEqual([
      "skill.draft.proposed",
      "skill.draft.dismissed",
      "skill.draft.proposed",
      "skill.draft.expired",
    ]);
  });

  it("the owner's edit is validated and re-read", async () => {
    const { d } = drafts();
    const draft = d.propose(routine()) as SkillDraft;
    expect((await rejects(() => d.update(draft.id, "no frontmatter"))).code).toBe("invalid_params");
    const edited = d.update(
      draft.id,
      draft.text.replace("name: same-week-thanks", "name: weekly-invoices"),
    );
    expect(edited).toMatchObject({ name: "weekly-invoices", edited: true });
  });
});

describe("accepting a draft", () => {
  it("replays it: no tools or approval kinds the routine never used, no vanished tools", async () => {
    const { d, t } = drafts();
    const draft = d.propose(routine()) as SkillDraft;
    d.update(
      draft.id,
      draft.text
        .replace("allowed-tools:\n", "allowed-tools:\n  - send_email\n")
        .replace("permissions:\n  - file_write", "permissions:\n  - file_write\n  - send_email"),
    );
    const err = await rejects(d.accept(draft.id));
    expect(err.code).toBe("policy_denied");
    expect((err.details as { problems: string[] }).problems).toEqual([
      "declares tools the routine never used: send_email",
      "asks for approval kinds the routine never needed: send_email",
    ]);
    expect(t.loader.names()).not.toContain("same-week-thanks");

    const gone = drafts();
    const g = gone.d.propose(routine()) as SkillDraft;
    const noSearch = new SkillDrafts({
      dir: join(gone.t.homeDir, ".drafts"),
      loader: gone.t.loader,
      knownTools: () => ["list_dir", "read_file", "write_file"],
    });
    expect(noSearch.replay(g).problems).toEqual(["tools no longer available: search_files"]);
  });

  it("goes through the T2 trust card and installs only with the owner's approval", async () => {
    const { t, d } = drafts();
    const draft = d.propose(routine()) as SkillDraft;
    const handlers = createSkillsHandlers(t.loader, { broker: t.broker, drafts: d });
    const {
      proposal,
      approval,
      draft: accepted,
    } = await handlers["skills.drafts.accept"]({
      draftId: draft.id,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      installProposalId: proposal.id,
      approvalId: approval.id,
      replay: { ok: true, problems: [] },
    });
    expect(approval).toMatchObject({
      kind: "skill_install",
      deviceOnly: true,
      scopesOffered: ["once"],
    });
    expect(approval.details).toMatchObject({ proposedBy: "agent", permissions: ["file_write"] });
    expect(approval.summary).toBe('Install skill Psyche proposed "same-week-thanks"');
    expect(proposal.findings.filter((f) => f.severity === "high")).toEqual([]);
    expect(proposal.trust).toBe("unknown");
    // Quarantined: the draft folder is never loaded as a skill.
    expect((await t.loader.list()).map((s) => s.name)).not.toContain("same-week-thanks");

    await t.loader.install(proposal.id, await approve(t.broker, t.clock, proposal));
    expect(d.installed("same-week-thanks")?.status).toBe("installed");
    const skill = (await t.loader.listDetailed()).find((s) => s.name === "same-week-thanks");
    expect(skill).toMatchObject({ status: "active", source: "home" });
    expect((await handlers["skills.drafts.list"]({ status: "installed" })).drafts).toHaveLength(1);
    // Installed: the same routine is not proposed again.
    expect(d.propose(routine({ threadId: "thr_5" }))).toBeUndefined();
  });
});
