import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import {
  type EverythingValues,
  ModelFields,
  PerSourceModels,
} from "../../memory/EverythingFields.tsx";
import { usePersona, useSlots } from "../../slots.tsx";
import { MemoryStoreGroups, type Notice, useAction } from "./DataControlsSection.tsx";
import { TimeField, useEverythingSetup } from "./EverythingMemorySection.tsx";
import { LearningGroup } from "./LearningGroup.tsx";
import { PeopleAdvancedGroups, readGraphSettings } from "./PeopleGraphSettings.tsx";
import { ErrorNotice, Group, LoadGate, SectionFrame, SwitchField } from "./shared.tsx";

/**
 * Settings → Memory → Advanced: the things most people never open. The model that reads, the
 * overnight schedule, how long things stay, how memory is recalled, encryption, what is learned
 * from feedback, and a way to your data. Each group is short; long wording sits behind "Learn
 * more" in the group that needs it.
 */

const GRAPH_SETTING = "memory.graph";

/** The model, per-source models, schedule and retention, shown once Everything memory is on. */
export function EverythingAdvancedGroups({
  value,
  onChange,
  localConfirmed,
  onConfirmLocal,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  localConfirmed: readonly string[];
  onConfirmLocal: (ref: string) => void;
}): ReactElement {
  const row = "flex items-center justify-between gap-3 text-body";
  const schedule = (patch: Partial<EverythingValues["schedule"]>) =>
    onChange({ ...value, schedule: { ...value.schedule, ...patch } });
  return (
    <>
      <ModelFields
        compact
        value={value}
        onChange={onChange}
        localConfirmed={localConfirmed}
        onConfirmLocal={onConfirmLocal}
      />
      <PerSourceModels
        value={value}
        onChange={onChange}
        localConfirmed={localConfirmed}
        onConfirmLocal={onConfirmLocal}
      />
      <Group title={t("everything.schedule.title")}>
        <TimeField
          label={t("everything.schedule.quietStart")}
          value={value.schedule.quietHoursStart}
          onChange={(v) => schedule({ quietHoursStart: v })}
        />
        <TimeField
          label={t("everything.schedule.quietEnd")}
          value={value.schedule.quietHoursEnd}
          onChange={(v) => schedule({ quietHoursEnd: v })}
        />
        <SwitchField
          label={t("everything.schedule.battery")}
          description={t("everything.schedule.batteryHint")}
          checked={value.schedule.runOnBattery}
          settingKey="memory.everything"
          onChange={(on) => schedule({ runOnBattery: on })}
        />
      </Group>
      <Group title={t("memoryAdvanced.keeping")} description={t("everything.storage.note")}>
        <div className={row}>
          <span>{t("memoryAdvanced.keepingPending")}</span>
          <span className="text-label-secondary">
            {t("memoryAdvanced.keepingDays", { days: value.retention.pendingDays })}
          </span>
        </div>
        <div className={row}>
          <span>{t("memoryAdvanced.keepingUntrusted")}</span>
          <span className="text-label-secondary">
            {t("memoryAdvanced.keepingMonths", { months: value.retention.untrustedAcceptedMonths })}
          </span>
        </div>
        <div className={row}>
          <span>{t("memoryAdvanced.keepingQuarantine")}</span>
          <span className="text-label-secondary">
            {t("memoryAdvanced.keepingDays", { days: value.retention.quarantineDays })}
          </span>
        </div>
      </Group>
    </>
  );
}

/** Connected: the Advanced section of the Memory page. */
export function MemoryAdvancedSection(): ReactElement {
  const setup = useEverythingSetup();
  const { form } = setup;
  const call = useCall();
  const persona = usePersona();
  const { navigate } = useSlots();
  const status = useGatewayQuery("memory.status", {});
  const graphStatus = useGatewayQuery("memory.graph.status", {});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const act = useAction(setBusy, setNotice);
  const graph = readGraphSettings(form.values);
  const shown =
    notice ?? (form.writeError ? { kind: "error" as const, text: form.writeError } : null);
  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("memoryAdvanced.title")}
      description={t("memoryAdvanced.description")}
    >
      <LoadGate
        label={t("memoryAdvanced.title")}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      >
        {shown === null ? null : shown.kind === "error" ? (
          <ErrorNotice what={shown.text} did="" />
        ) : (
          <p role="status" className="rounded-md bg-fill-tertiary px-3 py-2 text-callout">
            {shown.text}
          </p>
        )}
        {setup.value.enabled ? (
          <EverythingAdvancedGroups
            value={setup.value}
            onChange={setup.setValue}
            localConfirmed={setup.localConfirmed}
            onConfirmLocal={setup.confirmLocal}
          />
        ) : null}
        {graph.enabled ? (
          <PeopleAdvancedGroups
            settings={graph}
            onChange={(next) => form.onChange(GRAPH_SETTING, next)}
            status={graphStatus.data ?? null}
            persona={persona.name}
          />
        ) : null}
        <MemoryStoreGroups
          values={form.values}
          onChange={form.onChange}
          persona={persona.name}
          busy={busy}
          {...(status.data?.recall === undefined ? {} : { recall: status.data.recall })}
          // "Encrypt memory on disk" is not shown yet (EM9b): it waits for backups that carry the
          // encrypted file and its sealed key to be tried end to end. The groups can render it.
        />
        <LearningGroup
          values={form.values}
          onChange={form.onChange}
          persona={persona.name}
          busy={busy}
          {...(navigate ? { onOpenGrowth: () => navigate("/overview#growth") } : {})}
          onForgetAll={() =>
            void act(async () => {
              const r = await call("memory.lessons.forgetAll", {});
              return t("settings.learning.forgotAll", { lessons: r.lessons, events: r.events });
            }, "forget")
          }
        />
        <Group
          title={t("memoryAdvanced.data")}
          description={t("memoryAdvanced.dataHint", { persona: persona.name })}
        >
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!navigate}
              onClick={() => navigate?.("/settings/data")}
            >
              {t("memoryAdvanced.dataOpen")}
            </Button>
          </div>
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}
