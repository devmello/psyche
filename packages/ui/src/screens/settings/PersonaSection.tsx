import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Pencil } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { CREATURES, getCreature } from "../../avatar/creatures/index.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup } from "../../components/ui/radio-group.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  SwitchField,
  str,
  TextSetting,
  useSettingsForm,
} from "./shared.tsx";

/** Persona (UI design §3.18, avatar system §4.7). */

/** The bundled creature set as a labelled radio grid; each option shows the creature. */
export function CreaturePicker({
  value,
  onChange,
  label = t("settings.key.persona.creatureId"),
  personaName,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  personaName: string;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-headline text-label-primary">
        {label}
      </span>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={value}
        onValueChange={(v) => onChange(String(v))}
        className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-3"
      >
        {CREATURES.map((c) => (
          // One control per choice: the whole 72 px tile is the radio, named by the creature;
          // the selection is an accent ring, with no inner radio (redesign §5.9). Large tiles may
          // scale to 0.985 on press (motion.md §4.4).
          <RadioPrimitive.Root
            key={c.id}
            value={c.id}
            className="group/tile flex cursor-default flex-col items-center gap-1 rounded-lg p-1 text-callout text-label-secondary outline-none transition-transform duration-(--spring-micro-duration) ease-(--spring-micro) active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-ring data-checked:text-label-primary"
          >
            <span className="flex size-[72px] items-center justify-center rounded-full bg-fill-quaternary ring-offset-2 ring-offset-canvas group-data-checked/tile:ring-2 group-data-checked/tile:ring-accent-9">
              <Avatar name={personaName} creature={c.id} size={64} decorative />
            </span>
            <span>{c.name}</span>
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
      <p className="text-callout text-label-secondary" aria-live="polite">
        {getCreature(value).description}
      </p>
    </div>
  );
}

export interface PersonaPanelProps extends SettingsFormProps, LoadProps {
  /** Sends a natural-language change to the image model (or records it when there is none). */
  onDescribeChange?: (text: string) => void | Promise<void>;
  /** Whether an image model is configured, so "Describe a change" can redraw the avatar. */
  hasImageModel?: boolean;
}

export function PersonaPanel({
  values,
  onChange,
  needsApproval,
  onDescribeChange,
  hasImageModel = false,
  loading,
  error,
  onRetry,
}: PersonaPanelProps): ReactElement {
  const fallback = usePersona();
  const name = str(values, "persona.name", fallback.name);
  const creatureId = str(values, "persona.creatureId", fallback.creature);
  const tagline = str(values, "persona.tagline", "");
  const emoji = str(values, "persona.emoji", "");
  const description = str(values, "persona.creature", "");
  const [change, setChange] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const changeId = useId();

  const submitChange = async () => {
    const text = change.trim();
    if (text === "") return;
    if (onDescribeChange) await onDescribeChange(text);
    else onChange("persona.creature", text);
    setChange("");
    setSent(
      hasImageModel
        ? t("settings.persona.redrawn", { name })
        : t("settings.persona.savedForLater", { name }),
    );
  };

  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.persona.title")}
      description={t("settings.persona.description", { name })}
    >
      <LoadGate
        label={t("settings.persona.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-6 bg-gray-2 p-4">
          <Avatar name={name} creature={creatureId} size={64} />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">
              {emoji ? `${emoji} ` : ""}
              {name}
            </p>
            {tagline ? <p className="text-sm text-muted-foreground">{tagline}</p> : null}
            {description ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.persona.describedAs", { description })}
              </p>
            ) : null}
          </div>
        </div>

        <Group title={t("settings.persona.identity")}>
          <TextSetting
            label={t("settings.key.persona.name")}
            value={name}
            maxLength={40}
            settingKey="persona.name"
            onCommit={(v) => onChange("persona.name", v === "" ? "Psyche" : v)}
          />
          <TextSetting
            label={t("settings.key.persona.tagline")}
            value={tagline}
            maxLength={120}
            placeholder={t("settings.persona.taglinePlaceholder")}
            settingKey="persona.tagline"
            onCommit={(v) => onChange("persona.tagline", v)}
          />
          <TextSetting
            label={t("settings.key.persona.emoji")}
            description={t("settings.persona.emojiHint")}
            value={emoji}
            maxLength={8}
            settingKey="persona.emoji"
            onCommit={(v) => onChange("persona.emoji", v)}
          />
        </Group>

        <Group title={t("settings.persona.avatar")}>
          <CreaturePicker
            value={creatureId}
            personaName={name}
            onChange={(v) => onChange("persona.creatureId", v)}
          />
          <SettingHint settingKey="persona.creatureId" />
          <div className="flex flex-col gap-1">
            <Label htmlFor={changeId} className="gap-1.5">
              <Pencil className="size-3.5" aria-hidden="true" />
              {t("settings.persona.describeChange")}
            </Label>
            <p id={`${changeId}-desc`} className="text-xs text-muted-foreground">
              {hasImageModel
                ? t("settings.persona.describeHint")
                : t("settings.persona.describeHintNoModel")}
            </p>
            <Textarea
              id={changeId}
              aria-describedby={`${changeId}-desc`}
              value={change}
              onChange={(e) => setChange(e.target.value)}
              className="max-w-lg"
            />
            <div>
              <Button
                type="button"
                size="sm"
                disabled={change.trim() === ""}
                onClick={() => void submitChange()}
              >
                {t("settings.persona.apply")}
              </Button>
            </div>
            <SettingHint settingKey="persona.creature" />
            {sent ? (
              <p className="text-xs text-success-text" role="status">
                {sent}
              </p>
            ) : null}
          </div>
        </Group>

        <Group title={t("settings.persona.whileWorking")}>
          <SwitchField
            label={t("settings.key.agent.showReasoning")}
            description={t("settings.persona.showReasoningHint", { persona: name })}
            checked={bool(values, "agent.showReasoning", true)}
            settingKey="agent.showReasoning"
            onChange={(v) => onChange("agent.showReasoning", v)}
          />
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export interface PersonaSectionProps {
  onDescribeChange?: (text: string) => void | Promise<void>;
}

export function PersonaSection({ onDescribeChange }: PersonaSectionProps): ReactElement {
  const form = useSettingsForm();
  const image = str(form.values, "models.image", "none");
  return (
    <div className="flex flex-col gap-3">
      <PersonaPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        hasImageModel={image !== "none" && image !== ""}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(onDescribeChange ? { onDescribeChange } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
