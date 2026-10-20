import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Pencil } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { CREATURES, getCreature } from "../../avatar/creatures/index.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup } from "../../components/ui/radio-group.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { usePersona } from "../../slots.tsx";
import {
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  str,
  TextSetting,
  useSettingsForm,
} from "./shared.tsx";

/** Persona (UI design §3.18, avatar system §4.7). */

/** The bundled creature set as a labelled radio grid; each option shows the creature. */
export function CreaturePicker({
  value,
  onChange,
  label = "Creature",
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
      <span id={`${id}-label`} className="font-medium text-foreground">
        {label}
      </span>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={value}
        onValueChange={(v) => onChange(String(v))}
        className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6"
      >
        {CREATURES.map((c) => (
          // One control per choice: the whole tile is the radio, named by the creature.
          <RadioPrimitive.Root
            key={c.id}
            value={c.id}
            className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-gray-6 bg-background p-2 text-sm outline-none transition-colors hover:bg-gray-3 focus-visible:ring-3 focus-visible:ring-ring data-checked:border-accent-8 data-checked:bg-accent-3 data-checked:text-accent-12"
          >
            <Avatar name={personaName} creature={c.id} size={40} decorative />
            <span>{c.name}</span>
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground" aria-live="polite">
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
        ? `${name}'s avatar will be redrawn from your description.`
        : `Saved your description. Without an image model, ${name} keeps the creature picked below.`,
    );
  };

  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="Persona"
      description={`How ${name} looks and introduces itself. The Soul's tone lives in SOUL.md.`}
    >
      <LoadGate
        label="the persona"
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
              <p className="mt-1 text-xs text-muted-foreground">Described as: {description}</p>
            ) : null}
          </div>
        </div>

        <Group title="Identity">
          <TextSetting
            label="Name"
            value={name}
            maxLength={40}
            settingKey="persona.name"
            onCommit={(v) => onChange("persona.name", v === "" ? "Psyche" : v)}
          />
          <TextSetting
            label="Vibe or tagline"
            value={tagline}
            maxLength={120}
            placeholder="Quiet wings, careful hands."
            settingKey="persona.tagline"
            onCommit={(v) => onChange("persona.tagline", v)}
          />
          <TextSetting
            label="Emoji"
            description="Shown on channels that can't show the avatar."
            value={emoji}
            maxLength={8}
            settingKey="persona.emoji"
            onCommit={(v) => onChange("persona.emoji", v)}
          />
        </Group>

        <Group title="Avatar">
          <CreaturePicker
            value={creatureId}
            personaName={name}
            onChange={(v) => onChange("persona.creatureId", v)}
          />
          <SettingHint settingKey="persona.creatureId" />
          <div className="flex flex-col gap-1">
            <Label htmlFor={changeId} className="gap-1.5">
              <Pencil className="size-3.5" aria-hidden="true" />
              Describe a change
            </Label>
            <p id={`${changeId}-desc`} className="text-xs text-muted-foreground">
              {hasImageModel
                ? "In your own words, e.g. “give the moth a tiny scarf”."
                : "In your own words. Without an image model the description is saved for later."}
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
                Apply change
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
