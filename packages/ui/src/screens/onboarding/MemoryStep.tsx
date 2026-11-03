import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { WorkConsent } from "../settings/MemoryWorkSection.tsx";
import { Advanced, GROUP_ROWS, SwitchField } from "../settings/shared.tsx";
import type { HabitChoices } from "./habits.ts";
import { MemoryImportStep } from "./MemoryImportStep.tsx";
import type { MemoryChoices, OnboardingExtrasProps } from "./types.ts";

/** One titled block of the step: a heading, a line of what it is for, then its rows. */
function Block({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h2 id={id} className="text-headline text-label-primary">
          {title}
        </h2>
        {description ? <p className="text-callout text-label-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A switch the reminders above depend on is off: say so here and offer the one-click fix. */
function NeedsRow({
  text,
  action,
  onAction,
}: {
  text: string;
  action: string;
  onAction: () => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="memory-needs">
      <p className="min-w-0 flex-1 text-callout text-label-secondary">{text}</p>
      <Button type="button" size="sm" variant="outline" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

/**
 * Step 4: what Psyche does every day and what it keeps in memory (docs/design/onboarding-2026.md
 * §4). The daily switches come first, because they are what a new owner notices. Work tracking
 * is off until the owner has seen the same consent card Settings shows; the people switch says
 * who may see the brief. Due-soon reminders ride on the evening wrap-up, so turning them on with
 * the wrap-up off says so in place instead of letting nothing happen. Importing from another
 * assistant sits behind a fold.
 */
export function MemoryStep({
  persona,
  habits,
  onHabitsChange,
  memory,
  onMemoryChange,
  onPreviewImport,
  onCommitImport,
  now = () => new Date(),
}: {
  persona: string;
  habits: HabitChoices;
  onHabitsChange: (next: HabitChoices) => void;
  memory: MemoryChoices;
  onMemoryChange: (next: MemoryChoices) => void;
  onPreviewImport?: OnboardingExtrasProps["onPreviewImport"];
  onCommitImport?: OnboardingExtrasProps["onCommitImport"];
  now?: () => Date;
}): ReactElement {
  const [consent, setConsent] = useState(false);
  const setHabit = (key: keyof HabitChoices) => (on: boolean) =>
    onHabitsChange({ ...habits, [key]: on });
  const turnOnWork = () => {
    // Seen the card once: later switches on go straight through.
    if (memory.workConsentedAt !== null) onMemoryChange({ ...memory, work: true });
    else setConsent(true);
  };
  const canImport = onPreviewImport !== undefined && onCommitImport !== undefined;
  return (
    <div className="flex flex-col gap-7" data-testid="onboarding-memory-habits">
      <p className="text-reading text-label-secondary">
        {t("onboarding.memory.habitsLead", { name: persona })}
      </p>

      <Block title={t("onboarding.habits.title")} description={t("onboarding.habits.lead")}>
        <div className={GROUP_ROWS} data-testid="onboarding-habits">
          <SwitchField
            label={t("onboarding.habits.brief")}
            description={t("onboarding.habits.briefHint")}
            checked={habits.brief}
            onChange={setHabit("brief")}
          />
          <SwitchField
            label={t("onboarding.habits.wrapup")}
            description={t("onboarding.habits.wrapupHint")}
            checked={habits.wrapup}
            onChange={setHabit("wrapup")}
          />
          <SwitchField
            label={t("onboarding.habits.followups")}
            description={t("onboarding.habits.followupsHint")}
            checked={habits.followups}
            onChange={setHabit("followups")}
          />
        </div>
      </Block>

      <Block title={t("onboarding.work.title")}>
        <div className={GROUP_ROWS} data-testid="onboarding-work">
          <SwitchField
            label={t("memoryWork.enabled.label")}
            description={t("onboarding.work.hint", { persona })}
            checked={memory.work}
            onChange={(on) => (on ? turnOnWork() : onMemoryChange({ ...memory, work: false }))}
          />
          {memory.work ? (
            <SwitchField
              label={t("memoryWork.remind.enabled")}
              description={t("onboarding.work.remindHint")}
              checked={memory.remind}
              onChange={(on) => onMemoryChange({ ...memory, remind: on })}
            />
          ) : null}
          {memory.work && memory.remind && !habits.wrapup ? (
            <NeedsRow
              text={t("memoryWork.remind.needsWrapup")}
              action={t("memoryWork.remind.turnOnWrapup")}
              onAction={() => onHabitsChange({ ...habits, wrapup: true })}
            />
          ) : null}
        </div>
        {memory.work ? (
          <p className="px-1 text-callout text-label-secondary">{t("onboarding.work.later")}</p>
        ) : null}
      </Block>

      <Block title={t("onboarding.people.title")}>
        <div className={GROUP_ROWS} data-testid="onboarding-people">
          <SwitchField
            label={t("onboarding.people.label")}
            description={t("onboarding.people.hint")}
            checked={memory.people}
            onChange={(on) => onMemoryChange({ ...memory, people: on })}
          />
          {memory.people ? (
            <p role="status" className="text-callout text-label-secondary">
              {t("memorySurfaces.people.warning")}
            </p>
          ) : null}
          {memory.people && !habits.brief ? (
            <NeedsRow
              text={t("onboarding.people.needsBrief")}
              action={t("memoryWork.remind.turnOnBrief")}
              onAction={() => onHabitsChange({ ...habits, brief: true })}
            />
          ) : null}
        </div>
      </Block>

      {canImport ? (
        <Advanced title={t("onboarding.memory.bring")}>
          <MemoryImportStep onPreview={onPreviewImport} onCommit={onCommitImport} />
        </Advanced>
      ) : null}

      <WorkConsent
        open={consent}
        persona={persona}
        onCancel={() => setConsent(false)}
        onConfirm={() => {
          setConsent(false);
          onMemoryChange({ ...memory, work: true, workConsentedAt: now().toISOString() });
        }}
      />
    </div>
  );
}
