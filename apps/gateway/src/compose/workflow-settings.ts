import { getSetting, type PsycheDb } from "@psyche/db";
import type { LaunchResult, ProactiveJob } from "@psyche/proactive";
import { PsycheError } from "@psyche/protocol";

/**
 * Settings → Mail & meetings (docs/workflows/mail-and-meetings-2026.md §7.3) as the Gateway's mail
 * and meeting jobs read them. Every read goes to the database, so a change takes effect on the
 * next run; only the jobs' schedules need a sync when a key changes (`WORKFLOW_SETTING_KEYS`).
 * Values the owner cannot have meant (out of range, the wrong type) fall back to the default, and
 * a switch that was never touched is off: upgrades start with every workflow off (§7.5).
 */

/** Set once the upgrade Feed card (§7.5) was posted. */
export const UPGRADE_CARD_SETTING = "workflows.upgradeCardShown";

export const WORKFLOW_SETTING_KEYS = [
  "workflows.paused",
  "workflows.readOnly",
  "mail.digest.enabled",
  "mail.digest.time",
  "mail.digest.days",
  "mail.digest.onlyWhenNeeded",
  "mail.followups.enabled",
  "mail.followups.waitDays",
  "mail.followups.showTwice",
  "mail.voice.enabled",
  "mail.poll.activeMin",
  "mail.poll.idleMin",
  "meetings.prep.enabled",
  "meetings.prep.scope",
  "meetings.prep.leadMin",
  "meetings.prep.notifyMin",
  "meetings.prep.dailyCap",
  "meetings.notes.enabled",
  "meetings.notes.tasksApp",
  "meetings.notes.recapDraft",
  "meetings.notes.consentLine",
  "meetings.notes.cloudSummary",
] as const;

/** The prep run and its notice, before the meeting (§4.5), when the owner has not changed them. */
export const PREP_LEAD_MIN = 120;
export const PREP_NOTIFY_MIN = 60;

export interface WorkflowSettings {
  /** Every mail and meeting job stands still. */
  paused: boolean;
  /** Digests and prep keep going; nothing is proposed. */
  readOnly: boolean;
  digest: { enabled: boolean; time: unknown; days: unknown; onlyWhenNeeded: boolean };
  followups: { enabled: boolean; waitDays: number; showTwice: boolean };
  voiceEnabled: boolean;
  /** Minutes between mail checks while active / the least between checks otherwise; unset = default. */
  poll: { activeMin: number | undefined; idleMin: number | undefined };
  prep: {
    enabled: boolean;
    scope: "external" | "all";
    leadMin: number;
    notifyMin: number;
    dailyCap: number;
  };
  notes: {
    enabled: boolean;
    tasksApp: "reminders" | "things";
    recapDraft: boolean;
    consentLine: string | undefined;
    cloudSummary: boolean;
  };
}

const bool = (v: unknown): boolean => v === true;

function whole(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? Math.round(v)
    : undefined;
}

export function workflowSettings(db: PsycheDb): WorkflowSettings {
  const get = (key: string): unknown => getSetting(db, key)?.value;
  const consent = get("meetings.notes.consentLine");
  return {
    paused: bool(get("workflows.paused")),
    readOnly: bool(get("workflows.readOnly")),
    digest: {
      enabled: bool(get("mail.digest.enabled")),
      time: get("mail.digest.time"),
      days: get("mail.digest.days"),
      onlyWhenNeeded: bool(get("mail.digest.onlyWhenNeeded")),
    },
    followups: {
      enabled: bool(get("mail.followups.enabled")),
      waitDays: whole(get("mail.followups.waitDays"), 1, 30) ?? 3,
      // "Show at most twice" is on until the owner turns it off.
      showTwice: get("mail.followups.showTwice") !== false,
    },
    voiceEnabled: bool(get("mail.voice.enabled")),
    poll: {
      activeMin: whole(get("mail.poll.activeMin"), 1, 60),
      idleMin: whole(get("mail.poll.idleMin"), 1, 24 * 60),
    },
    prep: {
      enabled: bool(get("meetings.prep.enabled")),
      scope: get("meetings.prep.scope") === "all" ? "all" : "external",
      leadMin: whole(get("meetings.prep.leadMin"), 5, 24 * 60) ?? PREP_LEAD_MIN,
      notifyMin: whole(get("meetings.prep.notifyMin"), 1, 24 * 60) ?? PREP_NOTIFY_MIN,
      dailyCap: whole(get("meetings.prep.dailyCap"), 1, 4) ?? 4,
    },
    notes: {
      enabled: bool(get("meetings.notes.enabled")),
      tasksApp: get("meetings.notes.tasksApp") === "things" ? "things" : "reminders",
      recapDraft: bool(get("meetings.notes.recapDraft")),
      consentLine:
        typeof consent === "string" && consent.trim() !== ""
          ? consent.trim().slice(0, 300)
          : undefined,
      cloudSummary: bool(get("meetings.notes.cloudSummary")),
    },
  };
}

/**
 * A job that does nothing while the owner has paused the mail and meeting workflows. It reports
 * `no_reply` with the reason, so the run history shows why nothing happened.
 */
export function pausable(job: ProactiveJob, paused: () => boolean): ProactiveJob {
  return {
    name: job.name,
    matches: (a) => job.matches(a),
    run: async (request): Promise<LaunchResult> =>
      paused() ? { status: "no_reply", summary: "paused in Settings" } : job.run(request),
  };
}

/** Why meeting notes and recordings are off right now, or `undefined` when they may run. */
export function notesRefusal(s: WorkflowSettings): string | undefined {
  if (s.paused) {
    return "Mail and meeting workflows are paused. Turn them back on in Settings → Mail & meetings.";
  }
  if (!s.notes.enabled) {
    return "Meeting notes are off. Turn them on in Settings → Mail & meetings.";
  }
  return undefined;
}

/** Notes and recordings need the notes switch on and the workflows not paused. */
export function assertNotesAllowed(s: WorkflowSettings): void {
  const off = notesRefusal(s);
  if (off !== undefined) throw new PsycheError("forbidden", off);
}
