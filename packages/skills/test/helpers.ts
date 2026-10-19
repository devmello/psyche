import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_ARM_DELAY_MS } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import type { GateContext } from "../src/gating.ts";
import { FsSkillLoader, type FsSkillLoaderOptions, type SkillProposal } from "../src/loader.ts";

/** S20's bundled skills at the repository root. */
export const BUNDLED_DIR = fileURLToPath(new URL("../../../skills/", import.meta.url));

export function tempDir(prefix = "psyche-skills-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface SkillSpec {
  description?: string;
  body?: string;
  frontmatter?: string;
  files?: Record<string, string>;
}

export function skillMd(name: string, spec: SkillSpec = {}): string {
  return `---\nname: ${name}\ndescription: ${spec.description ?? `Does ${name} things.`}\n${spec.frontmatter ?? ""}---\n\n${spec.body ?? `# ${name}\n\nSteps for ${name}.\n`}`;
}

export function writeSkill(root: string, name: string, spec: SkillSpec = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd(name, spec));
  for (const [p, text] of Object.entries(spec.files ?? {})) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

export const OPEN_GATE: GateContext = {
  platform: "darwin",
  env: {},
  hasBin: () => true,
};

export function setup(over: Partial<FsSkillLoaderOptions> = {}) {
  const base = tempDir();
  const workspaceDir = join(base, "workspace", "skills");
  const homeDir = join(base, "home", "skills");
  const bundledDir = join(base, "bundled");
  for (const d of [workspaceDir, homeDir, bundledDir]) mkdirSync(d, { recursive: true });
  const clock = new FakeClock();
  const broker = new FakePermissionBroker({ clock });
  const events: unknown[] = [];
  const make = (extra: Partial<FsSkillLoaderOptions> = {}) =>
    new FsSkillLoader({
      workspaceDir,
      homeDir,
      bundledDir,
      broker,
      gate: OPEN_GATE,
      now: () => clock.now(),
      onChange: (e) => events.push(e),
      ...over,
      ...extra,
    });
  return { base, workspaceDir, homeDir, bundledDir, clock, broker, events, loader: make(), make };
}

/** Opens a `skill_install` card for the proposal and approves it as the owner's desktop. */
export async function approve(
  broker: FakePermissionBroker,
  clock: FakeClock,
  proposal: SkillProposal,
  binding = proposal.bindingHash,
): Promise<string> {
  const issued = await broker.requestApproval({
    kind: "skill_install",
    summary: `Install ${proposal.name}`,
    details: {},
    bindingHash: binding,
    grantKey: proposal.grantKey,
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    taint: false,
  });
  clock.advance(APPROVAL_ARM_DELAY_MS + 10);
  await broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop as string,
    decision: "approve",
    scope: "once",
    decidedBy: { deviceId: "dev1" },
  });
  return issued.approval.id;
}
