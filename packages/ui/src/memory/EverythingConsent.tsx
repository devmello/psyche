import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { t } from "../i18n/core.ts";
import { RadioField } from "../screens/settings/shared.tsx";
import {
  type EverythingValues,
  ModelFields,
  PeopleFields,
  SENSITIVE_IDS,
  SensitiveFields,
  SOURCE_IDS,
  SourceFields,
} from "./EverythingFields.tsx";

/**
 * First-run consent (docs/design/everything-memory-2026.md §12.1): what it does, the sources
 * (all off), people and privacy, who reads the day, then a summary. Nothing is saved until
 * "Turn on", and cancelling leaves the feature off. The backfill default is 30 days (decision 7).
 */

const STEPS = 5;

export function EverythingConsent({
  open,
  initial,
  persona,
  localConfirmed,
  onCancel,
  onFinish,
}: {
  open: boolean;
  initial: EverythingValues;
  persona: string;
  localConfirmed: string | undefined;
  onCancel: () => void;
  /** `confirmLocal` is the local model whose RAM warning the owner confirmed in this flow. */
  onFinish: (settings: EverythingValues, confirmLocal: string | undefined) => void;
}): ReactElement {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<EverythingValues>({ ...initial, enabled: true });
  const [confirm, setConfirm] = useState<string | undefined>(localConfirmed);
  const sources = SOURCE_IDS.filter((s) => draft.sources[s]);
  const sensitiveOn = SENSITIVE_IDS.filter((k) => draft.sensitive[k]).map((k) =>
    t(`everything.sensitive.${k}`),
  );
  const kind = draft.model.default.kind;
  const localReady =
    kind !== "local" ||
    (draft.model.default.ref !== undefined && confirm === draft.model.default.ref);
  const days = Number(draft.schedule.backfillDays);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        data-testid="everything-consent"
      >
        <DialogHeader>
          <DialogTitle>{t("everything.consent.title")}</DialogTitle>
          <DialogDescription>
            {t("everything.consent.step", { n: step, total: STEPS })}
          </DialogDescription>
        </DialogHeader>
        {step === 1 ? (
          <div className="flex flex-col gap-2" data-testid="consent-what">
            <h3 className="text-headline">{t("everything.consent.what.title")}</h3>
            <p>{t("everything.consent.what.body", { persona })}</p>
            <ul className="list-disc pl-5 text-label-secondary">
              <li>{t("everything.consent.what.e1")}</li>
              <li>{t("everything.consent.what.e2")}</li>
              <li>{t("everything.consent.what.e3")}</li>
            </ul>
          </div>
        ) : null}
        {step === 2 ? <SourceFields value={draft} onChange={setDraft} /> : null}
        {step === 3 ? (
          <div className="flex flex-col gap-3">
            <PeopleFields value={draft} onChange={setDraft} />
            <SensitiveFields value={draft} onChange={setDraft} />
            <RadioField
              label={t("everything.agent.title")}
              grouped
              value={draft.agentAccess}
              onChange={(a) => setDraft({ ...draft, agentAccess: a })}
              options={(["none", "accepted", "all"] as const).map((a) => ({
                value: a,
                label: t(`everything.agent.${a}`),
                hint: t(`everything.agent.${a}Hint`),
              }))}
            />
          </div>
        ) : null}
        {step === 4 ? (
          <div className="flex flex-col gap-3">
            <ModelFields
              value={draft}
              onChange={setDraft}
              localConfirmed={confirm}
              onConfirmLocal={setConfirm}
            />
            <RadioField
              label={t("everything.schedule.backfill")}
              grouped
              value={draft.schedule.backfillDays}
              onChange={(d) =>
                setDraft({ ...draft, schedule: { ...draft.schedule, backfillDays: d } })
              }
              options={(["0", "30", "90", "365"] as const).map((d) => ({
                value: d,
                label:
                  d === "0"
                    ? t("everything.schedule.backfillNone")
                    : t("everything.schedule.backfillDays", { days: Number(d) }),
              }))}
            />
          </div>
        ) : null}
        {step === 5 ? (
          <ul className="flex flex-col gap-1" data-testid="consent-summary">
            <li>
              {t("everything.consent.summary.model", { model: t(`everything.model.${kind}`) })}
            </li>
            <li>
              {t("everything.consent.summary.sources", {
                sources:
                  sources.length === 0
                    ? t("everything.consent.summary.none")
                    : sources.map((s) => t(`everything.source.${s}`)).join(", "),
              })}
            </li>
            <li>
              {t("everything.consent.summary.people", {
                people: t(`everything.people.${draft.people.default}`),
              })}
            </li>
            <li>
              {t("everything.consent.summary.sensitive", {
                on:
                  sensitiveOn.length === 0
                    ? t("everything.consent.summary.none")
                    : sensitiveOn.join(", "),
              })}
            </li>
            <li>
              {t("everything.consent.summary.agent", {
                access: t(`everything.agent.${draft.agentAccess}`),
              })}
            </li>
            <li>{t("everything.consent.summary.backfill", { days })}</li>
            {kind === "none" ? (
              <li className="text-label-secondary">{t("everything.consent.summary.noModel")}</li>
            ) : null}
          </ul>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("everything.consent.cancel")}
          </Button>
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep(step - 1)}>
              {t("everything.consent.back")}
            </Button>
          ) : null}
          {step < STEPS ? (
            <Button onClick={() => setStep(step + 1)}>{t("everything.consent.next")}</Button>
          ) : (
            <Button
              disabled={!localReady}
              onClick={() =>
                onFinish({ ...draft, enabled: true }, kind === "local" ? confirm : undefined)
              }
            >
              {t("everything.consent.finish")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
