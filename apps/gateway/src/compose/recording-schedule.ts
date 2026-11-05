import { readFileSync } from "node:fs";
import type { HookRegistry } from "@psyche/agent-core";
import {
  type Automation,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type Scheduler,
} from "@psyche/protocol";
import type { AutomationRunRequest, LaunchedRun, RunLauncher, RunResult } from "@psyche/scheduler";
import { buildUnattendedPrompt } from "@psyche/scheduler";
import {
  type ParsedRecordedStep,
  recordedStepFor,
  recordingUnattended,
  type UnattendedReason,
} from "@psyche/skills";
import type { HandlerDef } from "../context.ts";
import { assertDesktopRecording } from "./skills.ts";

/**
 * "Run it every week" for a skill made from a recording (docs/design/teach-by-showing-2026.md §8).
 *
 * Owner only. `skills.recording.schedule` accepts the Psyche desktop shell on the Host and no one
 * else, there is no agent tool for it, and the automation's `recordedSkill` marker is set by no
 * other method (the generic `automations.*` drop it). What it makes is an ordinary automation in
 * Scheduled, so it has history, a pause switch and a delete button, and every run goes through
 * the normal broker: an action that needs approval waits in the approvals queue (with a
 * notification) and the run waits with it.
 *
 * What an unattended run of a recording may not do, enforced here and not only asked of the model:
 * - It is refused at schedule time, and again at every run, when a step is sensitive or types a
 *   value that is asked for each run: nobody is there to answer.
 * - It acts only on an element that `browser.check_target` just answered `found` for. An action
 *   without such a check, or on another element, is blocked.
 * - Any other answer from `browser.check_target` ("missing", "ambiguous", "wrong_page") ends the
 *   run at once, as failed, with "the page changed at step N"; the scheduler notifies the owner.
 * - It cannot hand the tab over, fill a saved login, upload or drag.
 */

/** The few fields of an installed skill this module reads. */
export interface RecordedSkillMeta {
  name: string;
  source: string;
  status: string;
  enabled: boolean;
  path: string;
  madeBy?: string | undefined;
}

export interface RecordedSkillText {
  details: RecordedSkillMeta;
  text: string;
}

/** The installed skills made from a recording, as the Gateway's skill loader sees them. */
export interface RecordedSkills {
  /** An installed, enabled, unmodified skill made from a recording, with its text. */
  get(name: string): Promise<RecordedSkillText | undefined>;
  /** Why `get` found nothing: no such skill, not made from a recording, or off. */
  why(name: string): Promise<"not_recording" | "off">;
  /** Names of every skill made from a recording, whatever its state. */
  names(): Promise<string[]>;
}

export function recordedSkillsOf(loader: {
  listDetailed(): Promise<RecordedSkillMeta[]>;
}): RecordedSkills {
  const find = async (name: string) =>
    (await loader.listDetailed()).find((s) => s.name === name && s.madeBy === "recording");
  return {
    async get(name) {
      const d = await find(name);
      if (d === undefined || d.source !== "home" || d.status !== "active" || !d.enabled)
        return undefined;
      try {
        return { details: d, text: readFileSync(d.path, "utf8") };
      } catch {
        return undefined;
      }
    },
    async why(name) {
      const d = await find(name);
      return d === undefined ? "not_recording" : "off";
    },
    async names() {
      return (await loader.listDetailed())
        .filter((s) => s.madeBy === "recording")
        .map((s) => s.name);
    },
  };
}

/** The reasons as one plain sentence for an error (the Settings screen words them itself). */
export function unattendedSentence(reasons: readonly UnattendedReason[]): string {
  const parts = reasons.map((r) =>
    r.code === "sensitive"
      ? `step ${r.step} is a field you fill in yourself`
      : r.code === "input"
        ? `step ${r.step} asks for a value each time`
        : r.step === undefined
          ? "its steps cannot be read"
          : `step ${r.step} cannot be read`,
  );
  return `A run with nobody there cannot do this: ${parts.join("; ")}.`;
}

/** At most one run a day: a fixed minute and hour. Anything wilder is refused. */
const CRON = /^(\d{1,2}) (\d{1,2}) ([0-9*/,-]+) ([0-9*/,A-Za-z-]+) ([0-9*/,A-Za-z-]+)$/;
export function plainCron(schedule: string): boolean {
  const m = CRON.exec(schedule.trim());
  return m !== null && Number(m[1]) < 60 && Number(m[2]) < 24;
}

export function recordedTaskPrompt(skill: string): string {
  return `Run the browser task recorded in the skill "${skill}". Read it with skills_read, then follow it step by step in the browser.`;
}

/** The title of the skill (its first heading), for the Scheduled row; falls back to the name. */
function titleOf(text: string, name: string): string {
  const m = /^# (.{1,120})$/m.exec(text);
  const flat = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
  return flat === "" ? name : flat;
}

export interface RecordingScheduleDeps {
  skills: RecordedSkills;
  scheduler: Pick<Scheduler, "create" | "list">;
  timezone: () => string;
}

export function createRecordingScheduleHandlers(
  deps: RecordingScheduleDeps,
): Record<string, HandlerDef> {
  const unattended = async (name: string): Promise<MethodResult<"skills.recording.unattended">> => {
    const s = await deps.skills.get(name);
    if (s === undefined)
      return { eligible: false, steps: 0, reasons: [{ code: await deps.skills.why(name) }] };
    const c = recordingUnattended(s.text);
    return { eligible: c.eligible, steps: c.steps, reasons: c.reasons };
  };
  return {
    "skills.recording.unattended": {
      run: (_call, params) =>
        unattended((params as MethodParams<"skills.recording.unattended">).name),
    },
    "skills.recording.schedule": {
      run: async (call, params) => {
        // Owner only: the Psyche app on this Mac. A paired phone, a web client or a script with an
        // admin scope is refused, and the agent has no way to call a method at all.
        assertDesktopRecording(call.identity);
        const p = params as MethodParams<"skills.recording.schedule">;
        const s = await deps.skills.get(p.name);
        if (s === undefined)
          throw new PsycheError(
            "invalid_params",
            "That skill is not an installed skill made from a recording.",
          );
        const c = recordingUnattended(s.text);
        if (!c.eligible)
          throw new PsycheError("invalid_params", unattendedSentence(c.reasons), {
            details: { reasons: c.reasons },
          });
        if (!plainCron(p.schedule))
          throw new PsycheError(
            "invalid_params",
            "Pick a day and a time, such as every Monday at 9:00.",
          );
        const existing = (await deps.scheduler.list()).find(
          (a) => a.recordedSkill?.skill === p.name,
        );
        if (existing !== undefined)
          throw new PsycheError(
            "conflict",
            "That skill already runs on a schedule. See Scheduled.",
          );
        const automation = await deps.scheduler.create({
          kind: "cron",
          title: titleOf(s.text, p.name),
          schedule: p.schedule.trim(),
          timezone: p.timezone ?? deps.timezone(),
          sessionTarget: "isolated",
          delivery: {},
          prompt: recordedTaskPrompt(p.name),
          scratch: null,
          enabled: true,
          recordedSkill: { skill: p.name },
        });
        return { automation } satisfies { automation: Automation };
      },
    },
  };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

/** What the model is told for a run of a recording, on top of the unattended-run contract. */
export const RECORDED_RUN_RULES = [
  "This run repeats a task the owner recorded, with nobody watching. Follow the skill exactly:",
  "- Do the steps in order, and only those steps.",
  "- Before each step that acts on an element, call browser.check_target. Act only on the element it answers found for.",
  "- If it answers anything else (missing, ambiguous, wrong_page), or the page is not what the steps expect, the run stops there. Say which step in one line and end. Do not look for a similar element or try another way.",
  "- A step that needs the owner's approval waits for it. Do not skip it and do not do later steps first.",
  "- You cannot ask for a value, and you cannot hand the tab over: the skill holds every value this run needs.",
].join("\n");

/** What stops a recorded run, and the sentence the owner reads. */
export interface RecordedMiss {
  step: number | undefined;
  status: string;
}

export function missSentence(skill: string, miss: RecordedMiss): string {
  const where = miss.step === undefined ? "" : ` at step ${miss.step}`;
  const what =
    miss.status === "wrong_page"
      ? "it is on another page than the one you recorded"
      : miss.status === "ambiguous"
        ? "more than one thing on the page matches"
        : miss.status === "missing"
          ? "what it looks for is not on the page"
          : "it could not check the page";
  return `The page changed${where}: ${what}. Psyche stopped "${skill}" and did nothing more. Open the page and record it again if it moved.`;
}

interface RunGuard {
  skill: string;
  steps: readonly ParsedRecordedStep[];
  /** The last step whose element was found. */
  passed: number;
  /** The element the last `found` named; one action may use it. */
  armed: { ref: string } | undefined;
  miss: RecordedMiss | undefined;
}

const ACTING = new Set(["browser.click", "browser.type", "browser.press", "browser.select"]);
const NEVER = new Set([
  "browser.fill_credential",
  "browser.request_control",
  "browser.upload",
  "browser.drag",
]);

function refOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const p = params as { ref?: unknown; target?: unknown };
  if (typeof p.ref === "string") return p.ref;
  const t = p.target;
  if (typeof t === "object" && t !== null && typeof (t as { ref?: unknown }).ref === "string")
    return (t as { ref: string }).ref;
  return undefined;
}

function checkOf(output: unknown): { status?: string; ref?: string } | undefined {
  let o = output;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      return undefined;
    }
  }
  const c = (o as { check?: unknown } | null | undefined)?.check;
  return typeof c === "object" && c !== null ? (c as { status?: string; ref?: string }) : undefined;
}

/** The runs in flight and the rules each one is held to. */
export class RecordedRuns {
  readonly #guards = new Map<string, RunGuard>();
  readonly #launching = new Set<Promise<unknown>>();

  /** Registers a task that is about to be launched; awaited by the hooks so none is missed. */
  launching<T>(p: Promise<T>): Promise<T> {
    this.#launching.add(p);
    const done = () => this.#launching.delete(p);
    p.then(done, done);
    return p;
  }

  start(taskId: string, guard: RunGuard): void {
    this.#guards.set(taskId, guard);
  }

  end(taskId: string): void {
    this.#guards.delete(taskId);
  }

  async guardOf(taskId: string | undefined): Promise<RunGuard | undefined> {
    if (taskId === undefined) return undefined;
    if (this.#launching.size > 0) await Promise.allSettled([...this.#launching]);
    return this.#guards.get(taskId);
  }
}

/**
 * Holds a recorded run to the rules above. `cancel` ends the task (the scheduler then records the
 * run as failed with the sentence and notifies the owner).
 */
export function attachRecordedRunGuard(
  hooks: HookRegistry,
  runs: RecordedRuns,
  cancel: (taskId: string, reason: string) => Promise<unknown>,
): () => void {
  const offBefore = hooks.on("before_tool_call", async (ctx) => {
    const g = await runs.guardOf(ctx.taskId);
    if (g === undefined) return undefined;
    if (NEVER.has(ctx.tool))
      return {
        action: "block" as const,
        reason: "A scheduled run of a recording cannot do this: it needs the owner. Stop here.",
      };
    if (!ACTING.has(ctx.tool)) return undefined;
    const armed = g.armed;
    g.armed = undefined;
    const ref = refOf(ctx.params);
    if (armed === undefined || (ref !== undefined && ref !== armed.ref))
      return {
        action: "block" as const,
        reason:
          "Call browser.check_target for this step first and act only on the element it answers found for. This run does not guess.",
      };
    return undefined;
  });
  const offAfter = hooks.on("after_tool_call", async (ctx) => {
    if (ctx.tool !== "browser.check_target") return undefined;
    const g = await runs.guardOf(ctx.taskId);
    if (g === undefined || g.miss !== undefined || ctx.taskId === undefined) return undefined;
    const check = checkOf(ctx.result.output);
    if (ctx.result.isError !== true && check?.status === "found" && typeof check.ref === "string") {
      const name = (ctx.params as { name?: unknown } | null)?.name;
      g.passed =
        recordedStepFor(g.steps, typeof name === "string" ? { name } : {}, g.passed) ?? g.passed;
      g.armed = { ref: check.ref };
      return undefined;
    }
    const name = (ctx.params as { name?: unknown } | null)?.name;
    g.armed = undefined;
    g.miss = {
      step: recordedStepFor(g.steps, typeof name === "string" ? { name } : {}, g.passed),
      status: ctx.result.isError === true ? "error" : (check?.status ?? "error"),
    };
    await cancel(ctx.taskId, missSentence(g.skill, g.miss));
    return undefined;
  });
  return () => {
    offBefore();
    offAfter();
  };
}

export interface RecordedRunDeps {
  skills: RecordedSkills;
  runs: RecordedRuns;
}

const stopped = (summary: string): LaunchedRun => ({
  result: Promise.resolve<RunResult>({ status: "failed", summary }),
});

/**
 * Launches a scheduled recording. It looks the skill up again for every run (removed, turned off,
 * edited into something an unattended run cannot do: the run does not start and the owner is
 * told), builds the instruction itself instead of trusting the stored one, and turns a stop at a
 * changed page into a failed run with its sentence.
 */
export function withRecordedSkillRuns(inner: RunLauncher, deps: RecordedRunDeps): RunLauncher {
  return {
    async launch(request: AutomationRunRequest) {
      const rec = request.automation.recordedSkill;
      if (rec === undefined) return inner.launch(request);
      const s = await deps.skills.get(rec.skill);
      if (s === undefined)
        return stopped(
          `The skill "${rec.skill}" is not installed or is turned off, so nothing was run. Remove this schedule or turn the skill back on.`,
        );
      const check = recordingUnattended(s.text);
      if (!check.eligible)
        return stopped(
          `Nothing was run. ${unattendedSentence(check.reasons)} Remove this schedule, or record the task again without those steps.`,
        );
      const prompt = `${buildUnattendedPrompt(
        { ...request.automation, prompt: recordedTaskPrompt(rec.skill) },
        request.run,
      )}\n\n${RECORDED_RUN_RULES}`;
      const guard: RunGuard = {
        skill: rec.skill,
        steps: check.parsed,
        passed: 0,
        armed: undefined,
        miss: undefined,
      };
      const launched = await deps.runs.launching(inner.launch({ ...request, prompt }));
      const taskId = launched.taskId;
      if (taskId !== undefined) deps.runs.start(taskId, guard);
      return {
        ...launched,
        result: launched.result.then(
          (r): RunResult => {
            if (taskId !== undefined) deps.runs.end(taskId);
            return guard.miss === undefined
              ? r
              : {
                  status: "failed",
                  summary: missSentence(rec.skill, guard.miss),
                  ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
                };
          },
          (err) => {
            if (taskId !== undefined) deps.runs.end(taskId);
            throw err;
          },
        ),
      };
    },
    ...(inner.reattach === undefined ? {} : { reattach: inner.reattach.bind(inner) }),
    ...(inner.cancel === undefined ? {} : { cancel: inner.cancel.bind(inner) }),
  };
}

/**
 * The scheduler handed to the agent: it may not schedule a recorded skill. A prompt that names
 * one is refused, so the owner's own action (above) is the only way a recording runs unattended.
 * (The marker itself cannot be set by the agent's `schedule` tool, which has no such field.)
 */
export function withoutAgentRecordingSchedules(
  scheduler: Scheduler,
  skills: Pick<RecordedSkills, "names">,
): Scheduler {
  const mentions = async (text: string): Promise<string | undefined> => {
    const lower = text.toLowerCase();
    return (await skills.names()).find((n) => lower.includes(n.toLowerCase()));
  };
  return {
    ...scheduler,
    create: async (input) => {
      const hit = await mentions(`${input.title}\n${input.prompt}`);
      if (hit !== undefined)
        throw new PsycheError(
          "forbidden",
          `Only you can schedule "${hit}": open the skill in Settings and choose how often it runs.`,
        );
      return scheduler.create(input);
    },
    update: async (id, patch) => {
      const hit = await mentions(`${patch.title ?? ""}\n${patch.prompt ?? ""}`);
      if (hit !== undefined)
        throw new PsycheError(
          "forbidden",
          `Only you can schedule "${hit}": open the skill in Settings and choose how often it runs.`,
        );
      return scheduler.update(id, patch);
    },
    get: scheduler.get.bind(scheduler),
    list: scheduler.list.bind(scheduler),
    remove: scheduler.remove.bind(scheduler),
    nextRuns: scheduler.nextRuns.bind(scheduler),
    tick: scheduler.tick.bind(scheduler),
    runNow: scheduler.runNow.bind(scheduler),
  };
}
