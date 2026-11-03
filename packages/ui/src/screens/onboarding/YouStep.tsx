import { type ReactElement, useId } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useSettings } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import { LANGUAGE_SETTING } from "../../i18n/locale.ts";
import { LanguageSelect } from "../settings/LanguageSettings.tsx";
import { CreaturePicker } from "../settings/PersonaSection.tsx";
import { Advanced, RadioField } from "../settings/shared.tsx";
import type { OwnerProfile, PersonaDraft } from "./types.ts";

export const NAME_SUGGESTIONS = ["Juno", "Moss", "Pip"] as const;
export const DEFAULT_NAME = "Psyche";

/** The facts kept behind "More about you"; the owner's name has its own field above. */
const MORE_FIELDS = ["timeZone", "work", "city"] as const;

/**
 * The language, first thing in onboarding (A12, #621): written to `ui.language` at once, so the
 * rest of the flow already reads in it (AppearanceProvider remounts the app on a change).
 */
function OnboardingLanguage(): ReactElement {
  const id = useId();
  const { settings, set } = useSettings();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={`${id}-language`}>{t("onboarding.language.label")}</Label>
        <span id={`${id}-language-hint`} className="text-callout text-label-secondary">
          {t("onboarding.language.hint")}
        </span>
      </div>
      <LanguageSelect
        id={`${id}-language`}
        className="min-w-48"
        value={settings[LANGUAGE_SETTING]}
        describedBy={`${id}-language-hint`}
        onChange={(language) => void set(LANGUAGE_SETTING, language).catch(() => {})}
      />
    </div>
  );
}

/** Your agent: a small preview, its name with three suggestions, and the look behind a fold. */
function AgentSection({
  value,
  onChange,
}: {
  value: PersonaDraft;
  onChange: (next: PersonaDraft) => void;
}): ReactElement {
  const id = useId();
  const set = (patch: Partial<PersonaDraft>) => onChange({ ...value, ...patch });
  const name = value.name.trim() === "" ? DEFAULT_NAME : value.name.trim();
  return (
    <section aria-labelledby={`${id}-agent`} className="flex flex-col gap-4">
      <h2 id={`${id}-agent`} className="text-headline text-label-primary">
        {t("onboarding.you.agent")}
      </h2>
      <figure
        aria-label={t("onboarding.agent.preview")}
        data-testid="onboarding-preview"
        className="flex items-center gap-4"
      >
        <Avatar name={name} creature={value.creatureId} size={64} />
        <figcaption className="min-w-0">
          <span className="block text-title-3 text-label-primary">{name}</span>
          {value.tagline.trim() ? (
            <span className="block text-callout text-label-secondary">{value.tagline.trim()}</span>
          ) : null}
          {value.creatureMode === "describe" && value.creatureDescription.trim() ? (
            <span className="mt-1 block text-callout text-label-tertiary">
              “{value.creatureDescription.trim()}”
            </span>
          ) : null}
        </figcaption>
      </figure>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{t("onboarding.agent.name")}</Label>
        <Input
          id={`${id}-name`}
          maxLength={40}
          value={value.name}
          placeholder={DEFAULT_NAME}
          onChange={(e) => set({ name: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span id={`${id}-sugg`} className="text-callout text-label-secondary">
            {t("onboarding.agent.suggestions")}
          </span>
          <ul aria-labelledby={`${id}-sugg`} className="flex flex-wrap gap-1.5">
            {NAME_SUGGESTIONS.map((n) => (
              <li key={n}>
                <Button
                  type="button"
                  size="xs"
                  variant={value.name === n ? "secondary" : "ghost"}
                  aria-pressed={value.name === n}
                  onClick={() => set({ name: n })}
                >
                  {n}
                </Button>
              </li>
            ))}
            <li>
              <Button
                type="button"
                size="xs"
                variant={value.name === DEFAULT_NAME ? "secondary" : "ghost"}
                aria-pressed={value.name === DEFAULT_NAME}
                onClick={() => set({ name: DEFAULT_NAME })}
              >
                {t("onboarding.agent.keep", { name: DEFAULT_NAME })}
              </Button>
            </li>
          </ul>
        </div>
      </div>

      <Advanced title={t("onboarding.you.customize")}>
        <div className="flex min-w-0 flex-col gap-5" data-testid="onboarding-form">
          <CreaturePicker
            label={
              value.creatureMode === "describe"
                ? t("onboarding.agent.standIn")
                : t("onboarding.agent.bundled")
            }
            value={value.creatureId}
            personaName={name}
            onChange={(creatureId) => set({ creatureId })}
          />
          <RadioField
            label={t("onboarding.agent.creature")}
            inline
            value={value.creatureMode}
            onChange={(creatureMode) => set({ creatureMode })}
            options={[
              { value: "bundled", label: t("onboarding.agent.pickOne") },
              { value: "describe", label: t("onboarding.agent.describeIt") },
            ]}
          />
          {value.creatureMode === "describe" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-desc`}>{t("onboarding.agent.describe", { name })}</Label>
              <Textarea
                id={`${id}-desc`}
                aria-describedby={`${id}-desc-hint`}
                placeholder={t("onboarding.agent.describePlaceholder")}
                value={value.creatureDescription}
                onChange={(e) => set({ creatureDescription: e.target.value })}
              />
              <p id={`${id}-desc-hint`} className="text-callout text-label-secondary">
                {t("onboarding.agent.describeHint", { name })}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-tagline`}>{t("onboarding.agent.tagline")}</Label>
            <Input
              id={`${id}-tagline`}
              maxLength={120}
              placeholder={t("onboarding.agent.taglinePlaceholder")}
              value={value.tagline}
              onChange={(e) => set({ tagline: e.target.value })}
            />
          </div>
        </div>
      </Advanced>
    </section>
  );
}

/**
 * Step 1: language, the owner's name and the agent. Everything is optional. The owner's facts
 * land in USER.md; time zone, work and city sit behind "More about you" because the zone is
 * detected and the rest can wait. A re-run (`rerun`) leaves the agent out: it is edited in
 * Settings.
 */
export function YouStep({
  persona,
  onPersonaChange,
  owner,
  onOwnerChange,
  rerun = false,
}: {
  persona: PersonaDraft;
  onPersonaChange: (next: PersonaDraft) => void;
  owner: OwnerProfile;
  onOwnerChange: (next: OwnerProfile) => void;
  rerun?: boolean;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-you">
      <p className="text-reading text-label-secondary">{t("onboarding.you.lead")}</p>
      <OnboardingLanguage />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>{t("onboarding.about.name")}</Label>
        <Input
          id={`${id}-name`}
          value={owner.name}
          placeholder={t("onboarding.about.nameHint")}
          autoComplete="given-name"
          onChange={(e) => onOwnerChange({ ...owner, name: e.target.value })}
        />
      </div>
      {rerun ? null : <AgentSection value={persona} onChange={onPersonaChange} />}
      <Advanced title={t("onboarding.you.more")}>
        <div className="flex flex-col gap-4" data-testid="onboarding-about">
          <p className="text-callout text-label-secondary">{t("onboarding.about.lead")}</p>
          {MORE_FIELDS.map((key) => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-${key}`}>{tk(`onboarding.about.${key}`)}</Label>
              <Input
                id={`${id}-${key}`}
                value={owner[key]}
                placeholder={tk(`onboarding.about.${key}Hint`)}
                onChange={(e) => onOwnerChange({ ...owner, [key]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </Advanced>
    </div>
  );
}
