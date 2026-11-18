import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { type ReactElement, useId } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { CREATURES, getCreature } from "../../avatar/creatures/index.tsx";
import { RadioGroup } from "../../components/ui/radio-group.tsx";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
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
            <span className="flex size-18 items-center justify-center rounded-full bg-fill-quaternary ring-offset-2 ring-offset-canvas group-data-checked/tile:ring-2 group-data-checked/tile:ring-accent-9">
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
  loading,
  error,
  onRetry,
}: PersonaPanelProps): ReactElement {
  // The name and look come from IDENTITY.md (the `persona` slot). The name, tagline, emoji and
  // creature fields used to save to settings keys nothing reads, so they are not shown (#dead-controls).
  const fallback = usePersona();

  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.persona.title")}
      description={t("settings.persona.description", { name: fallback.name })}
    >
      <LoadGate
        label={t("settings.persona.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <div className="flex items-center gap-4 rounded-lg border border-gray-6 bg-gray-2 p-4">
          <Avatar name={fallback.name} creature={fallback.creature} size={64} />
          <p className="text-lg font-semibold">{fallback.name}</p>
        </div>

        <Group
          title={t("settings.persona.whileWorking")}
          description={t("settings.persona.whileWorkingHint")}
        >
          <SwitchField
            label={t("settings.key.agent.showReasoning")}
            description={t("settings.persona.showReasoningHint", { persona: fallback.name })}
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
  return (
    <div className="flex flex-col gap-3">
      <PersonaPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(onDescribeChange ? { onDescribeChange } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
