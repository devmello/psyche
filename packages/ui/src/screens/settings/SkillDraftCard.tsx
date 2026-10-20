import { sanitizeBlock, sanitizeDisplay } from "@psyche/permissions/cards";
import type { SkillDraft } from "@psyche/protocol";
import { Lightbulb } from "lucide-react";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { ErrorNotice, Group, messageOf, StatusChip } from "./shared.tsx";

/**
 * A skill the agent proposed from a routine it saw repeated (feature T3). The owner can edit the
 * draft's `SKILL.md`, review and install it (the replay check, then the same trust card and
 * device-only approval as any install) or dismiss it, after which the routine is never proposed
 * again. Nothing is installed from here directly.
 */

const effectLabel = (e: SkillDraft["steps"][number]["sideEffect"]): string =>
  t(`settings.skills.draft.effect.${e}`);

const show = (s: string, max = 300) => sanitizeDisplay(s, max);

export interface SkillDraftCardProps {
  draft: SkillDraft;
  persona: string;
  busy?: boolean;
  onSave?: (text: string) => Promise<unknown>;
  onAccept?: () => void;
  onDismiss?: () => void;
}

export function SkillDraftCard({
  draft,
  persona,
  busy = false,
  onSave,
  onAccept,
  onDismiss,
}: SkillDraftCardProps): ReactElement {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.text);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => setText(draft.text), [draft.text]);
  const name = show(draft.name, 64);
  return (
    <li
      aria-labelledby={id}
      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
      data-testid={`skill-draft-${draft.name}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={id} className="font-medium">
          {name}
        </span>
        <StatusChip tone="accent">
          {t("settings.skills.draft.seen", { n: draft.occurrences })}
        </StatusChip>
        {draft.edited ? (
          <StatusChip tone="neutral">{t("settings.skills.draft.edited")}</StatusChip>
        ) : null}
        {draft.tainted ? (
          <StatusChip tone="approval">{t("settings.skills.draft.tainted")}</StatusChip>
        ) : null}
      </div>
      <p className="text-muted-foreground">{show(draft.description, 400)}</p>
      <ol className="ms-5 list-decimal text-xs">
        {draft.steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps repeat tools; order is the identity
          <li key={`${s.tool}:${i}`}>
            <code>{show(s.tool, 80)}</code>{" "}
            {t("settings.skills.draft.step", {
              effect: effectLabel(s.sideEffect),
              summary: show(s.summary, 200),
            })}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {t("settings.skills.draft.redacted", { persona, n: draft.redactions })}
      </p>
      {draft.replay !== undefined && !draft.replay.ok ? (
        <ErrorNotice
          what={t("settings.skills.draft.noReplay", {
            problems: draft.replay.problems.map((p) => show(p)).join("; "),
          })}
          did={t("settings.skills.draft.editOrDismiss")}
        />
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSaveError(null);
            onSave?.(text).then(
              () => setEditing(false),
              (err: unknown) =>
                setSaveError(t("settings.skills.draft.saveFailed", { reason: messageOf(err) })),
            );
          }}
        >
          {/* i18n-ignore: the skill's file name */}
          <Label htmlFor={`${id}-text`}>SKILL.md</Label>
          <Textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            className="font-mono text-xs"
          />
          {saveError ? <ErrorNotice what={saveError} /> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t("common.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setText(draft.text);
                setEditing(false);
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <details>
          {/* i18n-ignore: the skill's file name */}
          <summary className="cursor-pointer text-xs font-medium">SKILL.md</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-gray-3 p-3 text-xs whitespace-pre-wrap">
            {sanitizeBlock(draft.text)}
          </pre>
        </details>
      )}
      {editing ? null : (
        <div className="flex flex-wrap gap-2">
          {onAccept ? (
            <Button type="button" size="sm" disabled={busy} onClick={onAccept}>
              {t("settings.skills.draft.review")}
            </Button>
          ) : null}
          {onSave ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t("common.edit")}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              aria-label={t("settings.skills.draft.dismissNamed", { name })}
            >
              {t("common.dismiss")}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}

export interface SkillSuggestionsProps
  extends Omit<SkillDraftCardProps, "draft" | "onSave" | "onAccept" | "onDismiss"> {
  drafts: readonly SkillDraft[];
  onSave?: (draft: SkillDraft, text: string) => Promise<unknown>;
  onAccept?: (draft: SkillDraft) => void;
  onDismiss?: (draft: SkillDraft) => void;
}

/** "Suggested by <persona>": open drafts, newest first; nothing when there are none. */
export function SkillSuggestions({
  drafts,
  persona,
  busy,
  onSave,
  onAccept,
  onDismiss,
}: SkillSuggestionsProps): ReactElement | null {
  if (drafts.length === 0) return null;
  return (
    <Group
      title={t("settings.skills.draft.suggestedBy", { persona })}
      description={t("settings.skills.draft.suggestedHint", { persona })}
      actions={<Lightbulb className="size-4 text-accent-11" aria-hidden="true" />}
    >
      <ul className="flex flex-col divide-y divide-gray-6">
        {drafts.map((d) => (
          <SkillDraftCard
            key={d.id}
            draft={d}
            persona={persona}
            {...(busy === undefined ? {} : { busy })}
            {...(onSave ? { onSave: (text: string) => onSave(d, text) } : {})}
            {...(onAccept ? { onAccept: () => onAccept(d) } : {})}
            {...(onDismiss ? { onDismiss: () => onDismiss(d) } : {})}
          />
        ))}
      </ul>
    </Group>
  );
}
