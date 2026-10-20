import type { SkillDetails, SkillDraft, SkillManifest, SkillProposal } from "@psyche/protocol";
import { ago, fakeSha, IDS, inMinutes } from "./ids.ts";

/**
 * Settings → Skills (feature T2): installed and bundled skills, plus what the MockGateway finds
 * when the owner reviews a folder. `skillSources` maps a folder path to the proposal the Gateway
 * would stage, or to the policy violations it would refuse with (`policy_denied`).
 */

export type MockSkillSource =
  | { proposal: Omit<SkillProposal, "id" | "expiresAt" | "bindingHash" | "grantKey"> }
  | { violations: string[] };

const NONE: SkillManifest = { tools: [], permissions: [], prompts: [] };

function skill(
  partial: Pick<SkillDetails, "name" | "description" | "source"> & Partial<SkillDetails>,
): SkillDetails {
  return {
    path: `~/.psyche/skills/${partial.name}/SKILL.md`,
    trust: partial.source === "bundled" ? "bundled" : "unknown",
    userInvocable: true,
    disableModelInvocation: false,
    enabled: true,
    hash: fakeSha(`skill:${partial.name}`),
    status: "active",
    reasons: [],
    findings: [],
    userEnabled: true,
    overrides: [],
    manifest: NONE,
    ...partial,
  };
}

export function skills(): SkillDetails[] {
  return [
    skill({
      name: "inbox-triage",
      description: "Sort today's mail into reply, read later and archive, and draft the replies.",
      source: "bundled",
      path: "skills/inbox-triage/SKILL.md",
      manifest: { tools: ["email.*"], permissions: ["send_email"], prompts: [] },
    }),
    skill({
      name: "calendar-planning",
      description: "Plan the week around your calendar, with buffers and focus time.",
      source: "bundled",
      path: "skills/calendar-planning/SKILL.md",
      enabled: false,
      status: "ineligible",
      reasons: [
        "needs a calendar: connect Google Calendar or Apple Calendar in Settings → Connectors",
      ],
      manifest: { tools: ["calendar.*"], permissions: ["calendar_write"], prompts: [] },
    }),
    skill({
      name: "weekly-review",
      description: "Every Friday, summarize the week's tasks, goals and open threads.",
      source: "bundled",
      path: "skills/weekly-review/SKILL.md",
      enabled: false,
      userEnabled: false,
      status: "disabled",
      reasons: ["disabled by the owner"],
    }),
    skill({
      name: "receipt-filer",
      description: "Save receipts from mail into Documents/Receipts with a dated file name.",
      source: "home",
      version: "1.2.0",
      manifest: {
        tools: ["email.read", "write_file"],
        permissions: ["file_write"],
        prompts: ["prompts/naming.md"],
      },
      findings: [
        { rule: "network-call", severity: "warn", message: "mentions a web address", line: 14 },
      ],
      update: {
        name: "receipt-filer",
        installedHash: fakeSha("skill:receipt-filer"),
        availableHash: fakeSha("skill:receipt-filer:1.3.0"),
        updateAvailable: true,
        manifestChanged: false,
        checkedAt: Date.parse(ago(30)),
      },
    }),
    skill({
      name: "crypto-helper",
      description: "Keeps your wallet tools up to date.",
      source: "home",
      enabled: false,
      status: "blocked",
      reasons: ["the static scan has high-severity findings"],
      findings: [
        {
          rule: "pipe-to-shell",
          severity: "high",
          message: "downloads a script and pipes it into a shell",
          file: "SKILL.md",
          line: 9,
        },
      ],
    }),
  ];
}

const PDF_MERGE_TEXT = `---
name: pdf-merge
description: Merge several PDFs from a granted folder into one file and save it next to them.
allowed-tools: [list_dir, read_file, write_file]
permissions: [file_write]
prompts: [prompts/naming.md]
---

# Merge PDFs

1. List the PDFs the owner named with \`list_dir\` and \`read_file\`.
2. Merge them in the order the owner gave.
3. Save the result with \`write_file\`; the write asks for approval.
`;

export const SKILL_FOLDER = "/Users/you/Downloads/pdf-merge";
export const GREEDY_SKILL_FOLDER = "/Users/you/Downloads/greedy-shell";

export function skillSources(): Record<string, MockSkillSource> {
  return {
    [SKILL_FOLDER]: {
      proposal: {
        name: "pdf-merge",
        source: { kind: "path", path: SKILL_FOLDER },
        text: PDF_MERGE_TEXT,
        hash: fakeSha("skill:pdf-merge"),
        trust: "unknown",
        findings: [],
        approvalKind: "skill_install",
        files: [
          {
            path: "SKILL.md",
            bytes: PDF_MERGE_TEXT.length,
            executable: false,
            text: PDF_MERGE_TEXT,
          },
          {
            path: "prompts/naming.md",
            bytes: 96,
            executable: false,
            text: "Use lowercase file names with hyphens. Never overwrite an existing file.\n",
          },
        ],
        scope: "home",
        manifest: {
          tools: ["list_dir", "read_file", "write_file"],
          permissions: ["file_write"],
          prompts: ["prompts/naming.md"],
        },
      },
    },
    [GREEDY_SKILL_FOLDER]: {
      violations: [
        "asks for the exec_host permission, which skills may not use",
        "declares the tool skills.install, which the policy denies (skills.install)",
      ],
    },
  };
}

/** A staged proposal as the Gateway returns it (stories of the trust card). */
export function stagedSkillProposal(): SkillProposal {
  const src = skillSources()[SKILL_FOLDER];
  if (src === undefined || !("proposal" in src)) throw new Error("fixture missing");
  return {
    ...src.proposal,
    id: "skp_fixture_pdf_merge",
    bindingHash: fakeSha("binding:skill:pdf-merge"),
    grantKey: fakeSha("grant:skill:pdf-merge"),
    expiresAt: Date.parse(inMinutes(30)),
  };
}

const DRAFT_TEXT = `---
name: export-week-invoices-finance
description: "Repeat the owner's routine for requests like: Export this week's invoices to Finance"
user-invocable: true
allowed-tools:
  - list_dir
  - read_file
  - write_file
permissions:
  - file_write
---

# Export Week Invoices Finance

Proposed by Psyche after the same steps ran 3 times in one conversation. Check every step before accepting.

## Steps

1. Call \`list_dir\` (reads) with inputs path.
2. Call \`read_file\` (reads) with inputs path.
3. Call \`write_file\` (changes something; asks when policy says so) with inputs path, content.
`;

/** An open agent-proposed draft (T3). The MockGateway stages it like a folder on accept. */
export function skillDrafts(): SkillDraft[] {
  return [
    {
      id: "skd_fixture_invoices",
      threadId: IDS.threads.main,
      name: "export-week-invoices-finance",
      description:
        "Repeat the owner's routine for requests like: Export this week's invoices to Finance",
      text: DRAFT_TEXT,
      manifest: {
        tools: ["list_dir", "read_file", "write_file"],
        permissions: ["file_write"],
        prompts: [],
      },
      steps: [
        { tool: "list_dir", sideEffect: "read", summary: "inputs: path" },
        { tool: "read_file", sideEffect: "read", summary: "inputs: path" },
        { tool: "write_file", sideEffect: "write", summary: "inputs: path, content" },
      ],
      occurrences: 3,
      signature: fakeSha("routine:invoices"),
      redactions: 1,
      tainted: false,
      edited: false,
      status: "open",
      createdAt: ago(45),
      updatedAt: ago(45),
    },
  ];
}
