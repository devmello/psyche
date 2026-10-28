import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { DailyWorkflowProposal } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { Card, type CardAction } from "./card.tsx";

/**
 * The confirm card for a planned workflow (task → automation): every schedule with its time,
 * days and timezone, what each run does, the approvals it will ask for and how it notifies.
 * The text is the model's and may echo untrusted content, so every value goes through the card
 * sanitizer and renders as plain text. Confirming is the owner's explicit approval of exactly
 * what is listed.
 */

export type WorkflowCardState = "idle" | "busy" | "done" | "declined" | "failed";

const clean = (s: string, max = 200) => sanitizeDisplay(s, max);

export function AutomationWorkflowCardView({
  proposal,
  state,
  scheduled = proposal.runs.length,
  onConfirm,
  onDecline,
}: {
  proposal: DailyWorkflowProposal;
  state: WorkflowCardState;
  scheduled?: number;
  onConfirm: () => void;
  onDecline: () => void;
}): ReactElement {
  const settled = state === "done" || state === "declined";
  const actions: CardAction[] = settled
    ? []
    : [
        {
          id: "decline",
          label: t("blocks.workflow.decline"),
          kind: "send",
          disabled: state === "busy",
          onSelect: onDecline,
        },
        {
          id: "confirm",
          label: state === "busy" ? t("blocks.workflow.scheduling") : t("blocks.workflow.confirm"),
          kind: "confirm",
          primary: true,
          disabled: state === "busy",
          onSelect: onConfirm,
        },
      ];
  return (
    <Card
      label={t("blocks.workflow.label")}
      title={t("blocks.workflow.title", { title: clean(proposal.title, 120) })}
      meta={t("blocks.workflow.runs", { count: proposal.runs.length })}
      actions={actions}
      actionSize="default"
      data-testid="workflow-card"
    >
      <div className="flex flex-col gap-3 text-callout">
        {proposal.tainted ? (
          <p role="note" className="text-label-secondary">
            {t("blocks.workflow.tainted")}
          </p>
        ) : null}
        <ol className="flex flex-col gap-3">
          {proposal.runs.map((r) => (
            <li key={r.name} className="flex flex-col gap-1" data-testid="workflow-run">
              <p className="text-headline">
                {t("blocks.workflow.runOf", {
                  name: clean(r.name, 80),
                  when: clean(r.humanSchedule),
                  timezone: clean(proposal.timezone, 60),
                })}
              </p>
              <p className="text-label-secondary">{t("blocks.workflow.does")}</p>
              <ul className="list-disc ps-5">
                {r.steps.map((s) => (
                  <li key={s}>{clean(s)}</li>
                ))}
              </ul>
              {r.approvals.length === 0 ? (
                <p className="text-label-secondary">{t("blocks.workflow.noApprovals")}</p>
              ) : (
                <>
                  <p className="text-label-secondary">{t("blocks.workflow.approvals")}</p>
                  <ul className="list-disc ps-5">
                    {r.approvals.map((a) => (
                      <li key={a}>{clean(a)}</li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ol>
        {proposal.obstacles.length > 0 ? (
          <div>
            <p className="text-label-secondary">{t("blocks.workflow.obstacles")}</p>
            <ul className="list-disc ps-5">
              {proposal.obstacles.map((o) => (
                <li key={o}>{clean(o, 300)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p>{t("blocks.workflow.notify", { how: proposal.notify })}</p>
        {proposal.offerSkill === true ? (
          <p className="text-label-secondary">{t("blocks.workflow.skillOffer")}</p>
        ) : null}
        <p role="status" aria-live="polite" className="text-label-secondary">
          {state === "done" ? t("blocks.workflow.done", { count: scheduled }) : null}
          {state === "declined" ? t("blocks.workflow.declined") : null}
          {state === "failed" ? t("blocks.workflow.failed") : null}
        </p>
      </div>
    </Card>
  );
}

/** The registered block: confirms through `daily.workflows.confirm`. */
export function AutomationWorkflowBlockView({
  proposal,
}: {
  proposal: DailyWorkflowProposal;
}): ReactElement {
  const store = useStore();
  const [state, setState] = useState<WorkflowCardState>("idle");
  const [count, setCount] = useState(proposal.runs.length);
  const confirm = () => {
    setState("busy");
    store
      .call("daily.workflows.confirm", { proposal })
      .then((r) => {
        setCount(r.automations.length);
        setState("done");
      })
      .catch(() => setState("failed"));
  };
  return (
    <AutomationWorkflowCardView
      proposal={proposal}
      state={state}
      scheduled={count}
      onConfirm={confirm}
      onDecline={() => setState("declined")}
    />
  );
}
