import type { EverythingExclusion } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import {
  EVERYTHING_KEY,
  type EverythingValues,
  PeopleFields,
  SensitiveFields,
} from "../../memory/EverythingFields.tsx";
import { ExclusionsPanel, type ExclusionsPanelProps } from "../../memory/ExclusionsPanel.tsx";
import { usePersona } from "../../slots.tsx";
import { useEverythingSetup } from "./EverythingMemorySection.tsx";
import { PeoplePrivacy } from "./PeoplePrivacy.tsx";
import { Group, LoadGate, RadioField, SectionFrame, SwitchField } from "./shared.tsx";

/**
 * Settings → Memory → Privacy: who Everything memory may learn about, which topics it may keep,
 * what the agent can see, who is never read, and how to make it forget. The controls that change
 * what is kept are all here, apart from the ones that turn learning on.
 */

/** What the agent may read of what was learned. */
export function AgentAccessGroup({
  value,
  onChange,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
}): ReactElement {
  return (
    <Group title={t("everything.agent.title")}>
      <RadioField
        label={t("everything.agent.title")}
        hideLabel
        grouped
        value={value.agentAccess}
        onChange={(a) => onChange({ ...value, agentAccess: a })}
        options={(["none", "accepted", "all"] as const).map((a) => ({
          value: a,
          label: t(`everything.agent.${a}`),
          hint: t(`everything.agent.${a}Hint`),
        }))}
      />
      <SwitchField
        label={t("everything.agent.sensitive")}
        checked={value.agentSeesSensitive}
        settingKey={EVERYTHING_KEY}
        onChange={(on) => onChange({ ...value, agentSeesSensitive: on })}
      />
    </Group>
  );
}

/** Connected: the Privacy section of the Memory page. */
export function MemoryPrivacySection(): ReactElement {
  const persona = usePersona();
  const call = useCall();
  const setup = useEverythingSetup();
  const { form } = setup;
  const list = useGatewayQuery("memory.exclusions.list", {});
  const status = useGatewayQuery("memory.graph.status", {});
  const [busy, setBusy] = useState(false);
  const fail = (err: unknown) =>
    toast.error(t("memoryReview.failed", { reason: describeError(err) }));

  const onAdd: ExclusionsPanelProps["onAdd"] = async (input) => {
    setBusy(true);
    try {
      const r = await call("memory.exclusions.add", input);
      if (input.dryRun !== true) list.reload();
      return r.forgotten;
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const onRemove = (e: EverythingExclusion) => {
    setBusy(true);
    call("memory.exclusions.remove", { id: e.id })
      .then(() => list.reload())
      .catch(fail)
      .finally(() => setBusy(false));
  };

  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("memoryPrivacy.title")}
      description={t("memoryPrivacy.description", { persona: persona.name })}
    >
      <LoadGate
        label={t("memoryPrivacy.title")}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      >
        {setup.value.enabled ? (
          <>
            <PeopleFields value={setup.value} onChange={setup.setValue} />
            <SensitiveFields value={setup.value} onChange={setup.setValue} collapsed />
            <AgentAccessGroup value={setup.value} onChange={setup.setValue} />
          </>
        ) : null}
        <ExclusionsPanel
          entries={list.data?.entries ?? []}
          busy={busy}
          onAdd={onAdd}
          onRemove={onRemove}
        />
        <PeoplePrivacy
          status={status.data ?? null}
          onChanged={() => {
            status.reload();
            form.reload();
          }}
        />
      </LoadGate>
    </SectionFrame>
  );
}
