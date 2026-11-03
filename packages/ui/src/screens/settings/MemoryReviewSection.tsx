import type { EverythingMemorySettings } from "@psyche/protocol";
import {
  EVERYTHING_MEMORY_DEFAULTS,
  EVERYTHING_MEMORY_SETTING_KEY,
  MEMORY_REVIEW_ROUTE,
} from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import {
  Group,
  LoadGate,
  SectionFrame,
  SettingRow,
  StatusChip,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Memory → Review: the rules for accepting without asking, and one row that opens the
 * queue, which lives on the Memory page (docs/design/memory-everything-2026.md §6.4). The defaults
 * are decision 6 of the everything-memory design: review everything, with two narrow exceptions
 * the owner can turn off.
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
    </Group>
  );
}

export function MemoryReviewSection(): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const { navigate } = useSlots();
  const waiting = useGatewayQuery("memory.review.list", { state: ["pending"], limit: 1 });
  const pending = waiting.data?.counts.pending ?? 0;
  const rules = readReviewRules(form.values);
  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("memoryReview.title")}
      description={t("memoryReview.settingsDescription", { persona: persona.name })}
    >
      <LoadGate
        label={t("memoryReview.loadLabel")}
        loading={waiting.loading && waiting.data === undefined}
        error={waiting.error}
        onRetry={waiting.reload}
      >
        <SettingRow
          label={t("memoryReview.link.label")}
          description={
            pending > 0 ? (
              <StatusChip tone="approval">{t("memoryReview.waiting", { n: pending })}</StatusChip>
            ) : (
              t("memoryReview.caughtUp")
            )
          }
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="review-link"
            onClick={() => navigate?.(MEMORY_REVIEW_ROUTE)}
          >
            {t("memoryReview.link.open")}
          </Button>
        </SettingRow>
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
