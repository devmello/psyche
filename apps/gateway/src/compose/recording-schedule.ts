import { createHash } from "node:crypto";
import type { HookRegistry } from "@psyche/agent-core";
import {
  type Automation,
  type AutomationRun,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type Scheduler,
} from "@psyche/protocol";
import type { AutomationRunRequest, LaunchedRun, RunLauncher, RunResult } from "@psyche/scheduler";
import { buildUnattendedPrompt } from "@psyche/scheduler";
import {
  type ParsedRecordedStep,
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
 * other method (the generic `automations.*` drop it; once set, the scheduler lets only `enabled`
 * change). What it makes is an ordinary automation in Scheduled, so it has history, a pause
 * switch and a delete button, and every run goes through the normal broker.
 *
 * What an unattended run of a recording may not do, enforced here and not only asked of the model:
 * - It is refused at schedule time, and again at every run, when a step is sensitive or types a
 *   value that is asked for each run: nobody is there to answer. The run also checks that the
 *   skill is the one the owner scheduled (its tree hash and its lessons hash) and pauses if not.
 * - It sees only the tools of the allowlist (browsing, reading the page, the four acting tools,
 *   its own skill). Everything else is not offered and, if called, blocked.
 * - It follows the recorded steps in order. It acts only on the element that `browser.check_target`
 *   just answered `found` for, when the check named exactly the next step (name, role, origin),
 *   with exactly the recorded value or key, and navigates only to origins the steps open.
 * - Any other answer from `browser.check_target`, and any approval the loop defers (nobody is there
 *   to answer it), ends the run at once as failed ("the page changed at step N", "waiting for your
 *   approval at step N") and pauses the schedule; the scheduler notifies the owner.
 */

/** The few fields of an installed skill this module reads. */
export interface RecordedSkillMeta {
  name: string;
  source: string;
  status: string;
  enabled: boolean;
  hash: string;
  madeBy?: string | undefined;
}

export interface RecordedSkillText {
  name: string;
  text: string;
  /** The skill's tree hash. */
  hash: string;
  /** A hash of the lesson lines loaded with it. */
  lessons: string;
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

export interface RecordedSkillLoader {
  listDetailed(): Promise<RecordedSkillMeta[]>;
  /** SKILL.md from the hashed tree. */
  skillText(name: string): string | undefined;
  /** The lesson lines that load with the skill. */
  lessons(name: string): string[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function recordedSkillsOf(loader: RecordedSkillLoader): RecordedSkills {
  const find = async (name: string) =>
    (await loader.listDetailed()).find((s) => s.name === name && s.madeBy === "recording");
  return {
    async get(name) {
      const d = await find(name);
      if (d === undefined || d.source !== "home" || d.status !== "active" || !d.enabled)
        return undefined;
      const text = loader.skillText(name);
      if (text === undefined) return undefined;
      return { name, text, hash: d.hash, lessons: sha(loader.lessons(name).join("\n")) };
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
  // One schedule call at a time, so two clicks cannot both pass the "already scheduled" check.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
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
        return serial(async () => {
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
            recordedSkill: { skill: p.name, hash: s.hash, lessons: s.lessons },
          });
          return { automation } satisfies { automation: Automation };
        });
      },
    },
  };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

/** What the model is told for a run of a recording, on top of the unattended-run contract. */
export const RECORDED_RUN_RULES = [
  "This run repeats a task the owner recorded, with nobody watching. Follow the skill exactly:",
  "- Do the steps in order, one at a time, and only those steps.",
  "- Open pages with browser.open_tab or browser.navigate, only at the addresses the steps name.",
  "- Before each step that acts on an element, call browser.check_target with that step's role and name and the origin of the page. Act only on the element it answers found for, with the value or key the step records.",
  "- If it answers anything else (missing, ambiguous, wrong_page), or the page is not what the steps expect, the run stops there. Say which step in one line and end. Do not look for a similar element or try another way.",
  "- If an action is queued for the owner's approval, the run stops there too, and the owner runs it again after approving.",
  "- You cannot ask for a value, and you cannot hand the tab over: the skill holds every value this run needs.",
].join("\n");

/** What stops a recorded run, and the sentence the owner reads. */
export interface RecordedMiss {
  step: number | undefined;
  status: string;
}

export function missSentence(skill: string, miss: RecordedMiss): string {
  const at = miss.step === undefined ? "" : ` at step ${miss.step}`;
  const tail = `Psyche stopped "${skill}" there and did nothing more. Paused: record it again, or resume it in Scheduled.`;
  if (miss.status === "approval")
    return `Waiting for your approval${at}: run it again after approving. ${tail}`;
  if (miss.status === "off_script") return `The run went off the recorded steps${at}. ${tail}`;
  const what =
    miss.status === "wrong_page"
      ? "it is on another page than the one you recorded"
      : miss.status === "ambiguous"
        ? "more than one thing on the page matches"
        : miss.status === "missing"
          ? "what it looks for is not on the page"
          : "it could not check the page";
  return `The page changed${at}: ${what}. ${tail}`;
}

interface RunGuard {
  skill: string;
  steps: readonly ParsedRecordedStep[];
  origins: ReadonlySet<string>;
  /** Index of the next step to do. */
  cursor: number;
  /** 1-based number of the step last started (for the sentence when an approval stops it). */
  attempt: number;
  /** The element the last matching check found; one action on it may follow. */
  armed: { tabId: string | undefined; ref: string; step: number } | undefined;
  blocked: number;
  miss: RecordedMiss | undefined;
}

/** Tools a recorded run is offered. Everything else is hidden from it and blocked if called. */
export const RECORDED_RUN_TOOLS: readonly string[] = [
  "browser.tabs",
  "browser.open_tab",
  "browser.focus_tab",
  "browser.close_tab",
  "browser.navigate",
  "browser.snapshot",
  "browser.find",
  "browser.check_target",
  "browser.read_text",
  "browser.wait",
  "browser.scroll",
  "browser.scroll_to",
  "browser.click",
  "browser.type",
  "browser.press",
  "browser.select",
  "skills_read",
  "update_plan",
  "wrap_up",
];

const ACTING = new Set(["browser.click", "browser.type", "browser.press", "browser.select"]);
const CLEARS_ARM = new Set([
  "browser.navigate",
  "browser.open_tab",
  "browser.close_tab",
  "browser.focus_tab",
]);
/** A run that is blocked this many times is not following the steps: it ends. */
const MAX_BLOCKS = 12;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function field<T = unknown>(params: unknown, key: string): T | undefined {
  return typeof params === "object" && params !== null
    ? ((params as Record<string, unknown>)[key] as T | undefined)
    : undefined;
}

function refOf(params: unknown): string | undefined {
  const ref = field<unknown>(params, "ref");
  if (typeof ref === "string") return ref;
  const t = field<unknown>(params, "target");
  const r = field<unknown>(t, "ref");
  return typeof r === "string" ? r : undefined;
}

function originOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
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

/** How long a tool call waits for a just-launched task to be registered before it moves on. */
const LAUNCH_WAIT_MS = 5_000;

/** The runs in flight and the rules each one is held to. */
export class RecordedRuns {
  readonly #guards = new Map<string, RunGuard>();
  readonly #runTask = new Map<string, string>();
  readonly #launching = new Set<Promise<unknown>>();
  readonly #waitMs: number;

  constructor(waitMs: number = LAUNCH_WAIT_MS) {
    this.#waitMs = waitMs;
  }

  /** Registers a launch in progress; awaited (briefly) by the hooks so no task is missed. */
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
    for (const [run, task] of this.#runTask) if (task === taskId) this.#runTask.delete(run);
  }

  async guardOf(ref: { taskId?: string | undefined; runId?: string | undefined }) {
    const taskId =
      ref.taskId ?? (ref.runId === undefined ? undefined : this.#runTask.get(ref.runId));
    if (taskId === undefined) return undefined;
    if (!this.#guards.has(taskId) && this.#launching.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.#launching]),
        new Promise((r) => {
          timer = setTimeout(r, this.#waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const guard = this.#guards.get(taskId);
    if (guard === undefined) return undefined;
    if (ref.runId !== undefined) this.#runTask.set(ref.runId, taskId);
    return { taskId, guard };
  }
}

/**
 * Holds a recorded run to the rules above. `cancel` ends the task (the scheduler then records the
 * run as failed with the sentence and notifies the owner). `names` lists the skills made from a
 * recording, so a task nobody scheduled as a recording cannot read one either.
 */
export function attachRecordedRunGuard(
  hooks: HookRegistry,
  runs: RecordedRuns,
  cancel: (taskId: string, reason: string) => Promise<unknown>,
  names: () => Promise<string[]> = async () => [],
): () => void {
  const stop = async (taskId: string, g: RunGuard, miss: RecordedMiss) => {
    if (g.miss !== undefined) return;
    g.miss = miss;
    g.armed = undefined;
    await cancel(taskId, missSentence(g.skill, miss));
  };
  const block = async (taskId: string, g: RunGuard, reason: string) => {
    g.blocked += 1;
    if (g.blocked > MAX_BLOCKS) await stop(taskId, g, { step: g.cursor + 1, status: "off_script" });
    return { action: "block" as const, reason };
  };

  const offPrompt = hooks.on("before_prompt_build", async (ctx) => {
    const hit = await runs.guardOf(ctx);
    return hit === undefined ? undefined : { toolsAllow: [...RECORDED_RUN_TOOLS] };
  });

  const offBefore = hooks.on("before_tool_call", async (ctx) => {
    const hit = await runs.guardOf(ctx);
    if (hit === undefined) {
      // A task nobody scheduled as a recording does not get to run one: it would run without the
      // rules (a prompt that names the skill, or an automation made over the protocol).
      if (ctx.tool === "skills_read" && ctx.mode === "unattended") {
        const name = field<unknown>(ctx.params, "name");
        if (typeof name === "string" && (await names()).includes(name))
          return {
            action: "block" as const,
            reason:
              "A skill made from a recording runs unattended only when you schedule it from the skill's page.",
          };
      }
      return undefined;
    }
    const { taskId, guard: g } = hit;
    if (!RECORDED_RUN_TOOLS.includes(ctx.tool))
      return block(taskId, g, "A scheduled run of a recording cannot use this tool.");
    if (ctx.tool === "skills_read") {
      return field(ctx.params, "name") === g.skill
        ? undefined
        : block(taskId, g, "Read only the skill you are running.");
    }
    if (CLEARS_ARM.has(ctx.tool)) g.armed = undefined;
    if (ctx.tool === "browser.navigate" || ctx.tool === "browser.open_tab") {
      const origin = originOf(field(ctx.params, "url"));
      if (origin === undefined || !g.origins.has(origin))
        return block(taskId, g, "Open only the addresses the recorded steps name.");
      const next = g.steps[g.cursor];
      if (next?.kind === "open" && next.origin === origin) {
        g.cursor += 1;
        g.attempt = next.n;
      }
      return undefined;
    }
    if (ctx.tool === "browser.check_target") {
      const step = g.steps[g.cursor];
      if (step === undefined || step.kind === "open")
        return block(taskId, g, `The next recorded step (${g.cursor + 1}) is not an element step.`);
      const name = field(ctx.params, "name");
      const role = field(ctx.params, "role");
      const origin = field(ctx.params, "origin");
      if (
        typeof name !== "string" ||
        step.name === undefined ||
        norm(name) !== norm(step.name) ||
        (step.role !== undefined && (typeof role !== "string" || norm(role) !== norm(step.role))) ||
        origin !== step.origin
      )
        return block(
          taskId,
          g,
          `Check the element of the next recorded step (step ${step.n}): its role, name and origin as the skill gives them.`,
        );
      return undefined;
    }
    if (!ACTING.has(ctx.tool)) return undefined;
    // An action: the next step, on the element just found for it, with exactly what was recorded.
    const step = g.steps[g.cursor];
    const armed = g.armed;
    g.armed = undefined;
    const ref = refOf(ctx.params);
    const tabId = field<string>(ctx.params, "tabId");
    const fail = (why: string) => block(taskId, g, `${why} This run does not guess.`);
    if (step === undefined) return fail("There is no recorded step left to do.");
    if (armed === undefined || armed.step !== g.cursor)
      return fail(
        `Call browser.check_target for step ${step.n} first and act only on what it finds.`,
      );
    if (ref === undefined || ref !== armed.ref)
      return fail("Act on the element the check found, by its ref.");
    if (armed.tabId !== undefined && tabId !== undefined && armed.tabId !== tabId)
      return fail("Act in the tab that was checked.");
    const ok =
      (step.kind === "click" &&
        ctx.tool === "browser.click" &&
        (field(ctx.params, "button") ?? "left") === "left" &&
        field(ctx.params, "double") !== true) ||
      (step.kind === "fill" &&
        step.verb === "type" &&
        ctx.tool === "browser.type" &&
        step.value !== undefined &&
        field(ctx.params, "text") === step.value &&
        field(ctx.params, "submit") !== true) ||
      (step.kind === "fill" &&
        step.verb === "select" &&
        ctx.tool === "browser.select" &&
        step.value !== undefined &&
        JSON.stringify(field(ctx.params, "values")) === JSON.stringify([step.value])) ||
      (step.kind === "press" &&
        ctx.tool === "browser.press" &&
        step.key !== undefined &&
        field(ctx.params, "keys") === step.key);
    if (!ok) return fail(`That is not what step ${step.n} recorded.`);
    g.cursor += 1;
    g.attempt = step.n;
    return undefined;
  });

  const offAfter = hooks.on("after_tool_call", async (ctx) => {
    if (ctx.tool !== "browser.check_target") return undefined;
    const hit = await runs.guardOf(ctx);
    if (hit === undefined || hit.guard.miss !== undefined) return undefined;
    const { taskId, guard: g } = hit;
    const check = checkOf(ctx.result.output);
    if (ctx.result.isError !== true && check?.status === "found" && typeof check.ref === "string") {
      g.armed = {
        tabId: field<string>(ctx.params, "tabId"),
        ref: check.ref,
        step: g.cursor,
      };
      return undefined;
    }
    await stop(taskId, g, {
      step: g.cursor + 1,
      status: ctx.result.isError === true ? "error" : (check?.status ?? "error"),
    });
    return undefined;
  });

  // The unattended loop does not wait for an approval: it answers the call with `deferred` and
  // lets the model carry on without it. A recording cannot carry on without a step, so a deferred
  // action ends the run, and the owner runs it again after approving.
  const offPersist = hooks.on("tool_result_persist", async ({ record, result }) => {
    const out = result.output as { deferred?: unknown } | null | undefined;
    if (out?.deferred !== true) return;
    const hit = await runs.guardOf({ runId: record.runId });
    if (hit === undefined) return;
    await stop(hit.taskId, hit.guard, {
      step: hit.guard.attempt > 0 ? hit.guard.attempt : hit.guard.cursor + 1,
      status: "approval",
    });
  });
  return () => {
    offPrompt();
    offBefore();
    offAfter();
    offPersist();
  };
}

export interface RecordedRunDeps {
  skills: RecordedSkills;
  runs: RecordedRuns;
  /** Pauses the schedule (a stop needs the owner before the next run). */
  pause?: (automationId: string) => Promise<unknown>;
  /** The automation a run belongs to (to tell a recorded run after a restart). */
  automationOf?: (automationId: string) => Promise<Automation | undefined>;
}

const stopped = (summary: string): LaunchedRun => ({
  result: Promise.resolve<RunResult>({ status: "failed", summary }),
});

const PAUSED = "Paused: record it again, or resume it in Scheduled.";

/**
 * Launches a scheduled recording. It looks the skill up again for every run (removed, turned off,
 * edited, its lessons changed, or edited into something an unattended run cannot do: the run does
 * not start, the schedule pauses and the owner is told), builds the instruction itself instead of
 * trusting the stored one, and turns a stop into a failed run with its sentence.
 */
export function withRecordedSkillRuns(inner: RunLauncher, deps: RecordedRunDeps): RunLauncher {
  const pause = (id: string) => {
    deps.pause?.(id)?.catch?.(() => {});
  };
  return {
    async launch(request: AutomationRunRequest) {
      const rec = request.automation.recordedSkill;
      if (rec === undefined) return inner.launch(request);
      const id = request.automation.id;
      const s = await deps.skills.get(rec.skill);
      if (s === undefined) {
        pause(id);
        return stopped(
          `The skill "${rec.skill}" is not installed or is turned off, so nothing was run. ${PAUSED}`,
        );
      }
      if (rec.hash !== s.hash || rec.lessons !== s.lessons) {
        pause(id);
        return stopped(
          `The skill "${rec.skill}" or its lessons changed since you scheduled it, so nothing was run. Open the skill, remove this schedule and schedule it again to confirm the change.`,
        );
      }
      const check = recordingUnattended(s.text);
      if (!check.eligible) {
        pause(id);
        return stopped(
          `Nothing was run. ${unattendedSentence(check.reasons)} Remove this schedule, or record the task again without those steps.`,
        );
      }
      // The instruction is ours: the stored title, scratch note, delivery and specialist are not
      // the owner's approved skill, so none of them reaches the run.
      const { specialist: _specialist, ...rest } = request.automation;
      const automation: Automation = {
        ...rest,
        title: rec.skill,
        scratch: null,
        delivery: {},
        prompt: recordedTaskPrompt(rec.skill),
      };
      const prompt = `${buildUnattendedPrompt(automation, request.run)}\n\n${RECORDED_RUN_RULES}`;
      const guard: RunGuard = {
        skill: rec.skill,
        steps: check.parsed,
        origins: new Set(
          check.parsed.flatMap((st) => (st.origin === undefined ? [] : [st.origin])),
        ),
        cursor: 0,
        attempt: 0,
        armed: undefined,
        blocked: 0,
        miss: undefined,
      };
      const launched = await deps.runs.launching(inner.launch({ ...request, automation, prompt }));
      const taskId = launched.taskId;
      if (taskId !== undefined) deps.runs.start(taskId, guard);
      const settle = (): void => {
        if (taskId !== undefined) deps.runs.end(taskId);
      };
      return {
        ...launched,
        result: launched.result.then(
          (r): RunResult => {
            settle();
            const withTask = r.taskId === undefined ? {} : { taskId: r.taskId };
            if (guard.miss !== undefined) {
              pause(id);
              return {
                status: "failed",
                summary: missSentence(rec.skill, guard.miss),
                ...withTask,
              };
            }
            // The model's own closing words are not the record: a finished run is one that did
            // every recorded step, and says only that.
            if (r.status === "done" || r.status === "no_reply") {
              return guard.cursor >= guard.steps.length
                ? {
                    status: "done",
                    summary: `Did all ${guard.steps.length} recorded steps of "${rec.skill}".`,
                    ...withTask,
                  }
                : {
                    status: "failed",
                    summary: `The run ended after ${guard.cursor} of ${guard.steps.length} recorded steps of "${rec.skill}".`,
                    ...withTask,
                  };
            }
            return {
              status: r.status,
              summary: `The run of "${rec.skill}" did not finish (${r.status}).`,
              ...withTask,
            };
          },
          (err) => {
            settle();
            throw err;
          },
        ),
      };
    },
    // After a restart the guard is gone, and a recorded run without its guard must not go on:
    // it is stopped, the schedule pauses, and the owner runs it again.
    reattach(run: AutomationRun) {
      const followed = inner.reattach?.(run);
      if (followed === undefined) return undefined;
      return (async (): Promise<RunResult> => {
        const a = await deps.automationOf?.(run.automationId);
        if (a?.recordedSkill === undefined) return followed;
        await inner.cancel?.(run, "The app restarted during a recorded run").catch(() => {});
        pause(run.automationId);
        return {
          status: "failed",
          summary: `The app restarted while "${a.recordedSkill.skill}" was running, so Psyche stopped it. ${PAUSED}`,
          ...(run.taskId == null ? {} : { taskId: run.taskId }),
        };
      })();
    },
    ...(inner.cancel === undefined ? {} : { cancel: inner.cancel.bind(inner) }),
  };
}

/**
 * The scheduler handed to the agent: it may not schedule a recorded skill. A job whose title or
 * text names one (its exact name, or the name with spaces or underscores) is refused, so the
 * owner's own action (above) is the only way a recording runs unattended. The marker itself
 * cannot be set by the agent's `schedule` tool, which has no such field. A name match cannot
 * catch a task described in other words; that becomes an ordinary automation, and the unattended
 * guard still blocks it from reading a recorded skill.
 */
export function withoutAgentRecordingSchedules(
  scheduler: Scheduler,
  skills: Pick<RecordedSkills, "names">,
): Scheduler {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = async (text: string): Promise<string | undefined> => {
    for (const n of await skills.names()) {
      const words = n.split("-").map(esc).join("[-_ ]+");
      if (new RegExp(`(?<![a-z0-9])${words}(?![a-z0-9])`, "i").test(text)) return n;
    }
    return undefined;
  };
  const refuse = (hit: string) =>
    new PsycheError(
      "forbidden",
      `Only you can schedule "${hit}": open the skill in Settings and choose how often it runs.`,
    );
  return {
    create: async (input) => {
      const hit = await mentions(`${input.title}\n${input.prompt}`);
      if (hit !== undefined) throw refuse(hit);
      return scheduler.create(input);
    },
    update: async (id, patch) => {
      const hit = await mentions(`${patch.title ?? ""}\n${patch.prompt ?? ""}`);
      if (hit !== undefined) throw refuse(hit);
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
