import type { Automation, AutomationRun } from "@psyche/protocol";
import { eventsBlock } from "./events.ts";

/** The reply that means "nothing to report" (architecture §4.3). */
export const NO_REPLY = "NO_REPLY";

function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

/**
 * The unattended-run contract (architecture §4.3; OpenClaw cron payloads) prepended to an
 * automation's prompt, with the catch-up note and the job's scratch note.
 */
export function buildUnattendedPrompt(automation: Automation, run: AutomationRun): string {
  const lines = [
    `[Unattended run of the automation "${automation.title}", scheduled for ${localTime(run.scheduledFor, automation.timezone)} (${automation.timezone}); trigger: ${run.trigger}.]`,
    "Nobody is present to answer questions or approve actions:",
    "- Your final message is the deliverable itself, not a plan, an acknowledgement or a question.",
    `- If there is nothing to report, reply exactly ${NO_REPLY}.`,
    "- Any action that needs approval is deferred into the approvals queue; do not wait for it.",
    "- A finished run is not proof that the job succeeded: say what you checked.",
  ];
  if (run.coalesced > 1) {
    lines.push(
      `This one run stands for ${run.coalesced} scheduled runs missed while the computer was asleep or off; cover the whole period once.`,
    );
  }
  const scratch = automation.scratch?.trim() ?? "";
  if (scratch !== "") {
    lines.push("", "Scratch note kept by earlier runs of this job:", scratch);
  }
  if (run.events !== undefined && run.events.length > 0) {
    lines.push("", eventsBlock(run.events));
  }
  lines.push("", "Job:", automation.prompt);
  return lines.join("\n");
}
