import {
  type NodeInfo,
  VM_SETTING_KEYS,
  type VmGuest,
  type VmUpdatedPayload,
} from "@psyche/protocol";
import { type ReactElement, useId } from "react";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useGatewayQuery, useVmGuests } from "../../data/hooks.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { usePersona } from "../../slots.tsx";
import {
  bool,
  EmptyNotice,
  ErrorNotice,
  Facts,
  Group,
  LoadGate,
  type LoadProps,
  RadioField,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  StatusChip,
  SwitchField,
  str,
  type Tone,
  useSettingsForm,
} from "./shared.tsx";

/**
 * VM mode (features L1–L5; UI design §3.18, §3.23; security §13): run Tasks in a sandbox Mac.
 * The four owner settings are admin keys (`VM_SETTING_KEYS`); the guest's state is what the mac
 * helper last reported through `vm.updated`. Nothing here boots a guest.
 */

export type VmWorkspace = "sandbox" | "vm";
export type VmClipboard = "paste-only" | "bidirectional" | "off";
export type VmCredentials = "host" | "guest";

export interface VmSettingsValue {
  enabled: boolean;
  guestNodeId: string | null;
  defaultWorkspace: VmWorkspace;
  clipboard: VmClipboard;
  credentials: VmCredentials;
}

/** The settings with the protocol's defaults for absent keys. */
export function vmSettingsOf(values: Readonly<Record<string, unknown>>): VmSettingsValue {
  const node = values[VM_SETTING_KEYS.guestNodeId];
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = str(values, key, fallback);
    return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  return {
    enabled: bool(values, VM_SETTING_KEYS.enabled, false),
    guestNodeId: typeof node === "string" && node !== "" ? node : null,
    defaultWorkspace: pick(VM_SETTING_KEYS.defaultWorkspace, ["sandbox", "vm"], "sandbox"),
    clipboard: pick(
      VM_SETTING_KEYS.clipboard,
      ["paste-only", "bidirectional", "off"],
      "paste-only",
    ),
    credentials: pick(VM_SETTING_KEYS.credentials, ["host", "guest"], "host"),
  };
}

const PHASE: Record<VmGuest["phase"], { label: string; tone: Tone }> = {
  created: { label: "Created", tone: "neutral" },
  installing: { label: "Installing macOS", tone: "info" },
  installed: { label: "Installed", tone: "neutral" },
  provisioning: { label: "Setting up", tone: "info" },
  stopped: { label: "Stopped", tone: "neutral" },
  starting: { label: "Starting", tone: "info" },
  running: { label: "Running", tone: "success" },
  stopping: { label: "Stopping", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
  paused: { label: "Paused", tone: "neutral" },
  saved: { label: "Saved", tone: "neutral" },
};

const CLIPBOARD_WORDS: Record<VmClipboard, string> = {
  "paste-only": "paste into the guest only",
  bidirectional: "both ways",
  off: "off",
};

function GuestCard({ report, now }: { report: VmUpdatedPayload; now: number }): ReactElement {
  const g = report.guest;
  const phase = PHASE[g.phase];
  return (
    <article
      aria-label={`Guest ${g.name}`}
      className="flex flex-col gap-3 rounded-md border border-gray-6 bg-background p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{g.name}</span>
        <StatusChip tone={phase.tone}>{phase.label}</StatusChip>
        <span className="ml-auto text-xs text-muted-foreground">
          Reported {formatRelative(report.at, now)}
        </span>
      </div>
      {g.phase === "failed" && g.lastError ? (
        <ErrorNotice what={`The guest stopped: ${g.lastError}.`} did="" />
      ) : null}
      <Facts
        items={[
          { term: "macOS", value: g.guestOS ?? "not installed yet" },
          {
            term: "Resources",
            value: `${g.cpus} CPUs · ${g.memoryGB} GB memory · ${g.diskGB} GB disk`,
          },
          {
            term: "Guest helper",
            value: g.agent?.connected
              ? `connected${g.agent.version ? ` (${g.agent.version})` : ""}`
              : "not connected",
          },
          {
            term: "Shared folders",
            value:
              g.shares.length === 0
                ? "none"
                : g.shares.map((s) => `${s.name} ${s.readOnly ? "ro" : "rw"}`).join(", "),
          },
          ...(g.clipboard ? [{ term: "Clipboard", value: CLIPBOARD_WORDS[g.clipboard] }] : []),
          ...(g.vault
            ? [{ term: "Credentials", value: g.vault === "host" ? "host vault" : "guest vault" }]
            : []),
        ]}
      />
    </article>
  );
}

export interface GuestNodeOption {
  id: string;
  name: string;
  status: NodeInfo["status"];
}

export interface VmPanelProps extends SettingsFormProps, LoadProps {
  persona: string;
  /** Paired psyche-node guests (`nodes.list`, kind `vm-guest`), named by their device. */
  guestNodes: readonly GuestNodeOption[];
  /** The latest `vm.updated` report per guest. */
  guests: readonly VmUpdatedPayload[];
  now?: number;
}

export function VmPanel({
  values,
  onChange,
  needsApproval,
  persona,
  guestNodes,
  guests,
  now,
  loading,
  error,
  onRetry,
}: VmPanelProps): ReactElement {
  const id = useId();
  const clock = useNow(30_000, now);
  const vm = vmSettingsOf(values);
  const K = VM_SETTING_KEYS;
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="VM mode"
      description={`Run tasks in a separate sandbox Mac, so ${persona} works in its own copy of macOS instead of yours.`}
    >
      <LoadGate
        label="VM settings"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Sandbox Mac">
          <SwitchField
            label="Use a sandbox Mac for tasks"
            description="Tasks that ask for it run in the guest. It sees only the folders you share, read-only unless you approve more."
            checked={vm.enabled}
            settingKey={K.enabled}
            onChange={(enabled) => onChange(K.enabled, enabled)}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-node`}>Guest that runs task commands</Label>
            <NativeSelect
              id={`${id}-node`}
              className="max-w-sm"
              value={vm.guestNodeId ?? ""}
              disabled={!vm.enabled}
              onChange={(e) =>
                onChange(K.guestNodeId, e.target.value === "" ? null : e.target.value)
              }
            >
              <option value="">
                {guestNodes.length === 0 ? "No guest is paired yet" : "Choose a guest"}
              </option>
              {guestNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                  {n.status === "online" ? "" : ` (${n.status})`}
                </option>
              ))}
            </NativeSelect>
            <SettingHint settingKey={K.guestNodeId} />
          </div>
          <RadioField<VmWorkspace>
            label="Where a task runs when it doesn't say"
            inline
            value={vm.defaultWorkspace}
            settingKey={K.defaultWorkspace}
            onChange={(v) => onChange(K.defaultWorkspace, v)}
            options={[
              { value: "sandbox", label: "Container sandbox" },
              { value: "vm", label: "Sandbox Mac", disabled: !vm.enabled },
            ]}
          />
        </Group>
        <Group
          title="Between your Mac and the guest"
          description="Copying files out of the guest is always an explicit copy with a receipt."
        >
          <RadioField<VmClipboard>
            label="Clipboard"
            inline
            value={vm.clipboard}
            settingKey={K.clipboard}
            onChange={(v) => onChange(K.clipboard, v)}
            options={[
              { value: "paste-only", label: "Paste into the guest only" },
              { value: "bidirectional", label: "Both ways" },
              { value: "off", label: "Off" },
            ]}
          />
          <RadioField<VmCredentials>
            label="Credentials"
            description="With the host vault, values stay on your Mac and are filled through the helper; a guest vault keeps its own copy inside the guest."
            inline
            value={vm.credentials}
            settingKey={K.credentials}
            onChange={(v) => onChange(K.credentials, v)}
            options={[
              { value: "host", label: "Host vault" },
              { value: "guest", label: "Guest vault" },
            ]}
          />
        </Group>
        <Group title="Guest status" description="What the Psyche helper last reported.">
          {guests.length === 0 ? (
            <EmptyNotice text="No guest has reported yet. Create one from the Psyche helper on this Mac; its state shows here." />
          ) : (
            guests.map((r) => (
              <GuestCard key={`${r.nodeId}/${r.guest.name}`} report={r} now={clock} />
            ))
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export function VmSection({ now }: { now?: number }): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const nodes = useGatewayQuery("nodes.list", {});
  const devices = useGatewayQuery("devices.list", {});
  const guests = useVmGuests();
  const deviceName = (id: string) =>
    devices.data?.devices.find((d) => d.id === id)?.name ?? "Sandbox Mac";
  const guestNodes = (nodes.data?.nodes ?? [])
    .filter((n) => n.kind === "vm-guest")
    .map((n) => ({ id: n.id, name: deviceName(n.deviceId), status: n.status }));
  return (
    <div className="flex flex-col gap-3">
      <VmPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        guestNodes={guestNodes}
        guests={guests}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(now === undefined ? {} : { now })}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
