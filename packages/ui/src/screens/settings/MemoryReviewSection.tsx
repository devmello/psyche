import type { EverythingMemorySettings } from "@psyche/protocol";
import { EVERYTHING_MEMORY_DEFAULTS, EVERYTHING_MEMORY_SETTING_KEY } from "@psyche/protocol";
import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { useMemoryReview } from "../../memory/hooks.ts";
import { MemoryReviewPanel } from "../../memory/MemoryReviewPanel.tsx";
import { usePersona } from "../../slots.tsx";
import { Group, LoadGate, SectionFrame, SwitchField, useSettingsForm } from "./shared.tsx";

/**
 * Settings → Privacy → Memory review (docs/design/everything-memory-2026.md §7): the queue, what
 * was added automatically (with Undo for a week), the quarantine, and the auto-accept rules. The
 * defaults are decision 6: review everything, with two narrow exceptions the owner can turn off.
 */

export type ReviewRules = EverythingMemorySettings["review"];

export function readReviewRules(values: Readonly<Record<string, unknown>>): ReviewRules {
  const raw = values[EVERYTHING_MEMORY_SETTING_KEY];
  const review =
    raw && typeof raw === "object" ? (raw as { review?: Partial<ReviewRules> }).review : undefined;
  return { ...EVERYTHING_MEMORY_DEFAULTS.review, ...(review ?? {}) };
}

export function RulesPanel({
  rules,
  onChange,
}: {
  rules: ReviewRules;
  onChange: (next: ReviewRules) => void;
}): ReactElement {
  return (
    <Group title={t("memoryReview.rules.title")} description={t("memoryReview.rules.description")}>
      <SwitchField
        label={t("memoryReview.rules.owner")}
        description={t("memoryReview.rules.ownerHint")}
        checked={rules.autoAcceptOwnerAuthored}
        settingKey={EVERYTHING_MEMORY_SETTING_KEY}
        onChange={(v) => onChange({ ...rules, autoAcceptOwnerAuthored: v })}
      />
      <SwitchField
        label={t("memoryReview.rules.self")}
        description={t("memoryReview.rules.selfHint", { n: rules.perSenderAutoAcceptAfter })}
        checked={rules.autoAcceptSelfDisclosure}
        settingKey={EVERYTHING_MEMORY_SETTING_KEY}
        onChange={(v) => onChange({ ...rules, autoAcceptSelfDisclosure: v })}
      />
      <p className="px-3 text-callout text-label-secondary">{t("memoryReview.rules.always")}</p>
    </Group>
  );
}

export function MemoryReviewSection(): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const review = useMemoryReview();
  const rules = readReviewRules(form.values);
  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("memoryReview.title")}
      description={t("memoryReview.description", { persona: persona.name })}
    >
      <LoadGate
        label={t("memoryReview.loadLabel")}
        loading={review.loading}
        error={review.error}
        onRetry={review.reload}
      >
        <p className="text-callout text-label-secondary" data-testid="review-counts">
          {t("memoryReview.counts", {
            review: review.counts.pending,
            auto: review.counts.autoAccepted,
            held: review.counts.quarantined,
          })}
        </p>
        <MemoryReviewPanel
          pending={review.pending}
          recent={review.recent}
          quarantine={review.quarantine}
          busy={review.busy}
          onAct={review.act}
          onActGroup={review.actGroup}
          onActQuarantine={review.actQuarantine}
        />
        <RulesPanel
          rules={rules}
          onChange={(next) => {
            const raw = form.values[EVERYTHING_MEMORY_SETTING_KEY];
            const base = raw && typeof raw === "object" ? raw : {};
            form.onChange(EVERYTHING_MEMORY_SETTING_KEY, { ...base, review: next });
          }}
        />
      </LoadGate>
    </SectionFrame>
  );
}
