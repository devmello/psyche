import type { EntitySummary } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useProjects } from "../../memory-page/work-hooks.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { rawOf, readWork, WORK_KEY, type WorkValues, withPath } from "./memory-work-values.ts";
import {
  EmptyNotice,
  Group,
  LoadGate,
  RadioField,
  SectionFrame,
  SettingHint,
  SettingRow,
  SwitchField,
  str,
  useSettingsForm,
} from "./shared.tsx";
import { type TrustSource, useHelperSources } from "./TrustedSourcesCard.tsx";

/** A Reminders list to track, and where it lives when that is not the helper's app. */
export type WorkList = TrustSource & { source?: string };

/**
 * The lists work tracking can follow: the helper's Reminders lists (Apple Reminders, or Outlook
 * tasks through the Windows helper) and every other Reminders backend the Gateway reads through
 * its connector (`memory.work.lists`: Microsoft To Do). The helper being away is only an error
 * when nothing else has lists either.
 */
export function useWorkLists(enabled: boolean): {
  sources: WorkList[] | null;
  loading: boolean;
  error: string | null;
} {
  const helper = useHelperSources("reminders", enabled);
  const backends = useGatewayQuery("memory.work.lists", {}, { enabled });
  if (!enabled) return { sources: null, loading: false, error: null };
  const mine = helper.sources ?? [];
  const more: WorkList[] = (backends.data?.lists ?? [])
    .filter((l) => !mine.some((h) => h.id === l.id))
    .map((l) => ({
      id: l.id,
      name: l.name,
      shared: l.shared,
      ...(l.source === undefined ? {} : { source: l.source }),
    }));
  const all = [...mine, ...more];
  const answered = helper.sources !== null || backends.data !== undefined;
  return {
    sources: answered ? all : null,
    loading: all.length === 0 && (helper.loading || backends.loading),
    error: all.length === 0 && !backends.loading ? helper.error : null,
  };
}

/**
 * Settings → Memory → Work (docs/design/memory-everything-2026.md §3.2, §5.4): the switch and its
 * consent card, which Reminders lists feed which project, which folders count as work, and the
 * opt-in due-soon notifications. Stored in `memory.work`; the Gateway's work pass runs only once
 * the owner has consented (`consentedAt`).
 *
 * Not here: work senders (course and work-tool mail) have no store yet, and
 * `memory.work.askWhereStopped` has no reader in the Gateway, so neither shows a control.
 */

const HOURS = [12, 24, 48, 72] as const;

/** The one-screen consent card shown before work tracking is turned on. */
export function WorkConsent({
  open,
  persona,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  persona: string;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="work-consent"
      >
        <DialogHeader>
          <DialogTitle>{t("memoryWork.consent.title")}</DialogTitle>
          <DialogDescription>{t("memoryWork.consent.body", { persona })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <h3 className="text-headline">{t("memoryWork.consent.reads")}</h3>
          <ul className="list-disc pl-5 text-label-secondary">
            <li>{t("memoryWork.consent.r1")}</li>
            <li>{t("memoryWork.consent.r2")}</li>
            <li>{t("memoryWork.consent.r3", { persona })}</li>
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-headline">{t("memoryWork.consent.keeps")}</h3>
          <ul className="list-disc pl-5 text-label-secondary">
            <li>{t("memoryWork.consent.k1")}</li>
            <li>{t("memoryWork.consent.k2")}</li>
            <li>{t("memoryWork.consent.k3")}</li>
          </ul>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("memoryWork.consent.cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("memoryWork.consent.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One Reminders list and the project it feeds (none: left alone). */
function ListRow({
  list,
  projects,
  value,
  onPick,
  settingKey,
}: {
  settingKey?: string;
  list: WorkList;
  projects: readonly EntitySummary[];
  value: string | undefined;
  onPick: (entityId: string | null) => void;
}): ReactElement {
  const known = value === undefined || projects.some((p) => p.id === value);
  return (
    <SettingRow
      label={list.name}
      {...(settingKey === undefined ? {} : { settingKey })}
      {...(list.shared
        ? { description: t("memoryWork.lists.shared") }
        : list.source !== undefined
          ? { description: list.source }
          : {})}
    >
      <NativeSelect
        aria-label={t("memoryWork.lists.pick", { list: list.name })}
        value={value ?? ""}
        onChange={(e) => onPick(e.target.value === "" ? null : e.target.value)}
        className="h-8 w-52"
      >
        <option value="">{t("memoryWork.lists.none")}</option>
        {known ? null : <option value={value}>{t("memoryWork.lists.missing")}</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </SettingRow>
  );
}

/** Which Reminders lists are tracked as work, and for which project or course. */
export function TrackedLists({
  tracked,
  lists,
  loading,
  error,
  projects,
  onChange,
  onOpenMemory,
}: {
  tracked: Readonly<Record<string, string>>;
  lists: readonly WorkList[] | null;
  loading: boolean;
  error: string | null;
  projects: readonly EntitySummary[];
  onChange: (next: Record<string, string>) => void;
  onOpenMemory?: () => void;
}): ReactElement {
  const pick = (id: string, entityId: string | null) => {
    const next = { ...tracked };
    if (entityId === null) delete next[id];
    else next[id] = entityId;
    onChange(next);
  };
  // A tracked list the helper no longer reports (deleted, or the helper is offline) still shows.
  const shown: WorkList[] = [
    ...(lists ?? []),
    ...Object.keys(tracked)
      .filter((id) => !(lists ?? []).some((l) => l.id === id))
      .map((id) => ({ id, name: t("memoryWork.lists.missing"), shared: false })),
  ];
  return (
    <Group title={t("memoryWork.lists.title")} description={t("memoryWork.lists.description")}>
      {projects.length === 0 ? (
        <EmptyNotice
          text={t("memoryWork.lists.noProjects")}
          action={
            onOpenMemory ? (
              <Button type="button" size="sm" variant="outline" onClick={onOpenMemory}>
                {t("memoryWork.lists.openMemory")}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {loading ? (
        <p className="text-callout text-label-secondary">{t("memoryWork.lists.loading")}</p>
      ) : null}
      {error !== null && shown.length === 0 ? (
        <p role="alert" className="text-callout text-label-secondary">
          {error}
        </p>
      ) : null}
      {!loading && error === null && shown.length === 0 ? (
        <p className="text-callout text-label-secondary">{t("memoryWork.lists.empty")}</p>
      ) : null}
      {shown.map((l, i) => (
        <ListRow
          key={l.id}
          list={l}
          projects={projects}
          value={tracked[l.id]}
          onPick={(e) => pick(l.id, e)}
          // Search jumps to the first row; the key covers the whole list.
          {...(i === 0 ? { settingKey: "memory.work.trackedLists" } : {})}
        />
      ))}
    </Group>
  );
}

/** Connected: `memory.work`, the helper's Reminders lists and the owner's projects. */
export function MemoryWorkSection(): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const { navigate } = useSlots();
  const [consent, setConsent] = useState(false);
  const work: WorkValues = readWork(form.values);
  const raw = rawOf(form.values, WORK_KEY);
  const projects = useProjects();
  const lists = useWorkLists(work.enabled);
  const put = (path: string, next: unknown) =>
    form.onChange(WORK_KEY, withPath(rawOf(form.values, WORK_KEY), path, next));

  const turnOn = () => {
    // Seen the card once: later switches on go straight through.
    if (work.consented) put("enabled", true);
    else setConsent(true);
  };
  const confirm = () => {
    setConsent(false);
    form.onChange(
      WORK_KEY,
      withPath(withPath(raw, "enabled", true), "consentedAt", new Date().toISOString()),
    );
  };

  const wrapupOn = form.values["daily.wrapup.enabled"] === true;
  const briefOn = form.values["daily.brief.enabled"] === true;
  const wrapupTime = str(form.values, "daily.wrapup.time", "18:00");

  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("memoryWork.title")}
      description={t("memoryWork.description", { persona: persona.name })}
    >
      <LoadGate
        label={t("memoryWork.loadLabel")}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      >
        <SettingHint settingKey={WORK_KEY} />
        <Group title={t("memoryWork.enabled.title")}>
          <SwitchField
            label={t("memoryWork.enabled.label")}
            description={work.enabled ? t("memoryWork.enabled.hint") : t("memoryWork.enabled.off")}
            settingKey="memory.work.enabled"
            checked={work.enabled}
            onChange={(on) => (on ? turnOn() : put("enabled", false))}
          />
        </Group>

        {work.enabled ? (
          <>
            <TrackedLists
              tracked={work.trackedLists}
              lists={lists.sources}
              loading={lists.loading}
              error={lists.error}
              projects={projects.projects}
              onChange={(next) => put("trackedLists", next)}
              {...(navigate ? { onOpenMemory: () => navigate("/memory") } : {})}
            />

            <Group title={t("memoryWork.folders.title")}>
              <RadioField
                label={t("memoryWork.folders.title")}
                hideLabel
                grouped
                settingKey="memory.work.anchorsFromFolders"
                value={work.anchorsFromFolders}
                onChange={(v) => put("anchorsFromFolders", v)}
                options={[
                  {
                    value: "anchored_only",
                    label: t("memoryWork.folders.anchored"),
                    hint: t("memoryWork.folders.anchoredHint", { persona: persona.name }),
                  },
                  {
                    value: "all_granted",
                    label: t("memoryWork.folders.all", { persona: persona.name }),
                    hint: t("memoryWork.folders.allHint"),
                  },
                ]}
              />
            </Group>

            <Group
              title={t("memoryWork.remind.title")}
              description={t("memoryWork.remind.description")}
            >
              <SwitchField
                label={t("memoryWork.remind.enabled")}
                description={t("memoryWork.remind.enabledHint", {
                  hours: work.remind.dueSoonHours,
                })}
                settingKey="memory.work.remind.enabled"
                checked={work.remind.enabled}
                onChange={(on) => put("remind.enabled", on)}
              />
              {work.remind.enabled ? (
                <>
                  <SettingRow
                    label={t("memoryWork.remind.hours")}
                    settingKey="memory.work.remind.dueSoonHours"
                  >
                    <NativeSelect
                      aria-label={t("memoryWork.remind.hours")}
                      value={String(work.remind.dueSoonHours)}
                      onChange={(e) => put("remind.dueSoonHours", Number(e.target.value))}
                      className="h-8 w-32"
                    >
                      {(HOURS.includes(work.remind.dueSoonHours as (typeof HOURS)[number])
                        ? HOURS
                        : [...HOURS, work.remind.dueSoonHours].sort((a, b) => a - b)
                      ).map((h) => (
                        <option key={h} value={h}>
                          {t("memoryWork.remind.hoursOption", { hours: h })}
                        </option>
                      ))}
                    </NativeSelect>
                  </SettingRow>
                  <SettingRow
                    label={t("memoryWork.remind.at")}
                    description={t("memoryWork.remind.atHint")}
                  >
                    <span className="text-body text-label-secondary">
                      {t("memoryWork.remind.atWrapup", { time: wrapupTime })}
                    </span>
                    {navigate ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => navigate("/settings/daily")}
                      >
                        {t("memoryWork.remind.openDaily")}
                      </Button>
                    ) : null}
                  </SettingRow>
                  {wrapupOn ? null : (
                    <SettingRow label={t("memoryWork.remind.needsWrapup")}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => form.onChange("daily.wrapup.enabled", true)}
                      >
                        {t("memoryWork.remind.turnOnWrapup")}
                      </Button>
                    </SettingRow>
                  )}
                </>
              ) : null}
              <SwitchField
                label={t("memoryWork.remind.dayOf")}
                description={t("memoryWork.remind.dayOfHint")}
                settingKey="memory.work.remind.dayOf"
                checked={work.remind.dayOf}
                onChange={(on) => put("remind.dayOf", on)}
              />
              {work.remind.dayOf && !briefOn ? (
                <SettingRow label={t("memoryWork.remind.needsBrief")}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => form.onChange("daily.brief.enabled", true)}
                  >
                    {t("memoryWork.remind.turnOnBrief")}
                  </Button>
                </SettingRow>
              ) : null}
            </Group>
          </>
        ) : null}
      </LoadGate>
      <WorkConsent
        open={consent}
        persona={persona.name}
        onCancel={() => setConsent(false)}
        onConfirm={confirm}
      />
    </SectionFrame>
  );
}
