import { GATEWAY_RESTART_NOTE, RUN_SNAPSHOT_BODY, type RunStep } from "@psyche/protocol";
import { t } from "./core.ts";

/**
 * Text the Gateway stores in English next to a key: step labels with a fixed wording, the restart
 * note and the Feed line of a finished run. Clients word them here, in the owner's language, and
 * show the stored English when the key is missing or unknown (older rows, newer Gateways).
 */

const STEP_TEXT = {
  reply: ["chat.steps.fixed.reply", "chat.steps.fixed.replyDone"],
  file: ["chat.steps.fixed.file", "chat.steps.fixed.fileDone"],
  model: ["chat.steps.fixed.model", "chat.steps.fixed.model"],
  thinking: ["chat.steps.fixed.thinking", "chat.steps.fixed.thinkingDone"],
} as const;

/** The step's status line, in the right tense when `done`; the stored text for an unkeyed step. */
export function runStepText(step: RunStep, done: boolean): string {
  const ids = step.labelKey === undefined ? undefined : STEP_TEXT[step.labelKey];
  if (ids === undefined) return done ? (step.doneLabel ?? step.label) : step.label;
  return t(done ? ids[1] : ids[0]);
}

/** A system note block: the translated sentence when the Gateway sent a key we know. */
export function systemNoteText(block: { md: string; noteKey?: string | undefined }): string {
  return block.noteKey === GATEWAY_RESTART_NOTE.key ? t("chat.system.gatewayRestart") : block.md;
}

/** A Feed post's body: the two stored generic run lines are shown translated. */
export function feedBodyText(bodyMd: string): string {
  if (bodyMd === RUN_SNAPSHOT_BODY.done) return t("chat.feed.runDone");
  if (bodyMd === RUN_SNAPSHOT_BODY.failed) return t("chat.feed.runFailed");
  return bodyMd;
}
