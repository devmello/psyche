import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import type { PersonaIdentity } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { CREATURES, getCreature } from "../../avatar/creatures/index.tsx";
import { RadioGroup } from "../../components/ui/radio-group.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
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
  /** The persona from IDENTITY.md; the `persona` slot stands in until it loads. */
  identity?: PersonaIdentity;
  /** Saves persona fields through `memory.persona.edit`. Rejects with the Gateway's error. */
  onSaveIdentity?: (fields: Partial<PersonaIdentity>) => Promise<void>;
  /** The last save's failure, shown above the fields. */
  saveError?: string | null;
}

export function PersonaPanel({
  values,
  onChange,
  needsApproval,
  loading,
  error,
  onRetry,
  identity,
  onSaveIdentity,
  saveError,
}: PersonaPanelProps): ReactElement {
  const fallback = usePersona();
  const name = identity?.name ?? fallback.name;
  const creature = identity?.creature ?? fallback.creature;
  const save = (fields: Partial<PersonaIdentity>) => {
    if (onSaveIdentity) void onSaveIdentity(fields);
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
          <Avatar name={name} creature={creature} size={64} />
          <p className="text-lg font-semibold">
            {identity?.emoji ? `${identity.emoji} ` : ""}
            {name}
          </p>
        </div>

        <Group
          title={t("settings.persona.identity")}
          description={t("settings.persona.identityHint")}
        >
          <TextSetting
            label={t("settings.key.persona.name")}
            value={name}
            maxLength={40}
            // An empty name is refused by the Gateway; TextSetting then keeps the typed draft.
            onCommit={(v) => {
              if (v !== "") save({ name: v });
            }}
          />
          <TextSetting
            label={t("settings.key.persona.tagline")}
            value={identity?.tagline ?? ""}
            maxLength={120}
            placeholder={t("settings.persona.taglinePlaceholder")}
            onCommit={(v) => save({ tagline: v })}
          />
          <TextSetting
            label={t("settings.key.persona.emoji")}
            description={t("settings.persona.emojiHint")}
            value={identity?.emoji ?? ""}
            maxLength={16}
            onCommit={(v) => save({ emoji: v })}
          />
        </Group>

        <Group title={t("settings.persona.avatar")} description={t("settings.persona.avatarHint")}>
          <CreaturePicker
            value={creature}
            personaName={name}
            onChange={(id) => save({ creature: id })}
          />
        </Group>

        {saveError ? <ErrorNotice what={saveError} did="" /> : null}

        <Group
          title={t("settings.persona.whileWorking")}
          description={t("settings.persona.whileWorkingHint")}
        >
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
  /**
   * "Describe a change" is not shown: nothing here sends it to the agent yet (it needs an image
   * model or a chat path). Kept so the Settings screen's wiring does not change.
   */
  onDescribeChange?: (text: string) => void | Promise<void>;
}

export function PersonaSection(_props: PersonaSectionProps): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const persona = useGatewayQuery("memory.persona.get", {});
  // The result of the last save, shown at once; the web shell also refreshes from IDENTITY.md.
  const [saved, setSaved] = useState<PersonaIdentity | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const identity = saved ?? persona.data?.identity;

  const onSaveIdentity = async (fields: Partial<PersonaIdentity>) => {
    setSaveError(null);
    try {
      const result = await call("memory.persona.edit", { fields });
      setSaved(result.identity);
    } catch (err) {
      setSaveError(
        t("settings.shared.saveFailed", {
          label: t("settings.persona.title"),
          reason: messageOf(err),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <PersonaPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        identity={identity}
        onSaveIdentity={onSaveIdentity}
        saveError={saveError}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
