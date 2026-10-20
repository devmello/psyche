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
import { t } from "../../i18n/core.ts";
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

const PHASE_TONE: Record<VmGuest["phase"], Tone> = {
  created: "neutral",
  installing: "info",
  installed: "neutral",
  provisioning: "info",
  stopped: "neutral",
  starting: "info",
  running: "success",
  stopping: "info",
  failed: "danger",
  paused: "neutral",
  saved: "neutral",
};

const clipboardLabel = (c: VmClipboard): string =>
  t(`settings.vm.clipboard.${c === "paste-only" ? "pasteOnly" : c}`);
const vaultLabel = (v: VmCredentials): string => t(`settings.vm.vault.${v}`);

function GuestCard({ report, now }: { report: VmUpdatedPayload; now: number }): ReactElement {
  const g = report.guest;
  return (
    <article
      aria-label={t("settings.vm.guestNamed", { name: g.name })}
      className="flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{g.name}</span>
        <StatusChip tone={PHASE_TONE[g.phase]}>{t(`settings.vm.phase.${g.phase}`)}</StatusChip>
        <span className="ms-auto text-xs text-muted-foreground">
          {t("settings.vm.reported", { when: formatRelative(report.at, now) })}
        </span>
      </div>
      {g.phase === "failed" && g.lastError ? (
        <ErrorNotice
          what={t("settings.vm.stopped", { error: g.lastError })}
          did={t("settings.vm.tasksWait")}
        />
      ) : null}
      <Facts
        items={[
          // i18n-ignore: the operating system's name
          { term: "macOS", value: g.guestOS ?? t("settings.vm.notInstalled") },
          {
            term: t("settings.vm.resources"),
            value: t("settings.vm.resourcesValue", {
              cpus: g.cpus,
              memory: g.memoryGB,
              disk: g.diskGB,
            }),
          },
          {
            term: t("settings.vm.guestHelper"),
            value: g.agent?.connected
              ? g.agent.version
                ? t("settings.vm.connectedVersion", { version: g.agent.version })
                : t("settings.vm.connected")
              : t("settings.vm.notConnected"),
          },
          {
            term: t("settings.key.permissions.folders"),
            value:
              g.shares.length === 0
                ? t("settings.vm.none")
                : g.shares
                    .map((s) =>
                      t("settings.vm.share", { name: s.name, readOnly: s.readOnly === true }),
                    )
                    .join(", "),
          },
          ...(g.clipboard
            ? [{ term: t("settings.key.vm.clipboard"), value: clipboardLabel(g.clipboard) }]
            : []),
          ...(g.vault ? [{ term: t("settings.vm.credentials"), value: vaultLabel(g.vault) }] : []),
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
      title={t("settings.nav.vm")}
      description={t("settings.vm.description", { persona })}
    >
      <LoadGate
        label={t("settings.vm.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.vm.sandboxMac")}>
          <SwitchField
            label={t("settings.key.vm.enabled")}
            description={t("settings.vm.enabledHint")}
            checked={vm.enabled}
            settingKey={K.enabled}
            onChange={(enabled) => onChange(K.enabled, enabled)}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-node`}>{t("settings.key.vm.guestNodeId")}</Label>
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
                {guestNodes.length === 0 ? t("settings.vm.noGuest") : t("settings.vm.chooseGuest")}
              </option>
              {guestNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.status === "online"
                    ? n.name
                    : t("settings.vm.guestStatus", { name: n.name, status: n.status })}
                </option>
              ))}
            </NativeSelect>
            <SettingHint settingKey={K.guestNodeId} />
          </div>
          <RadioField<VmWorkspace>
            label={t("settings.vm.defaultWorkspace")}
            inline
            value={vm.defaultWorkspace}
            settingKey={K.defaultWorkspace}
            onChange={(v) => onChange(K.defaultWorkspace, v)}
            options={[
              { value: "sandbox", label: t("settings.vm.workspace.sandbox") },
              { value: "vm", label: t("settings.vm.sandboxMac"), disabled: !vm.enabled },
            ]}
          />
        </Group>
        <Group title={t("settings.vm.between")} description={t("settings.vm.betweenHint")}>
          <RadioField<VmClipboard>
            label={t("settings.key.vm.clipboard")}
            inline
            value={vm.clipboard}
            settingKey={K.clipboard}
            onChange={(v) => onChange(K.clipboard, v)}
            options={[
              { value: "paste-only", label: clipboardLabel("paste-only") },
              { value: "bidirectional", label: clipboardLabel("bidirectional") },
              { value: "off", label: clipboardLabel("off") },
            ]}
          />
          <RadioField<VmCredentials>
            label={t("settings.vm.credentials")}
            description={t("settings.vm.credentialsHint")}
            inline
            value={vm.credentials}
            settingKey={K.credentials}
            onChange={(v) => onChange(K.credentials, v)}
            options={[
              { value: "host", label: vaultLabel("host") },
              { value: "guest", label: vaultLabel("guest") },
            ]}
          />
        </Group>
        <Group
          title={t("settings.vm.guestStatusTitle")}
          description={t("settings.vm.guestStatusHint")}
        >
          {guests.length === 0 ? (
            <EmptyNotice text={t("settings.vm.noReports")} />
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
    devices.data?.devices.find((d) => d.id === id)?.name ?? t("settings.vm.sandboxMac");
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
        error={form.error ?? nodes.error ?? devices.error}
        onRetry={() => {
          form.reload();
          nodes.reload();
          devices.reload();
        }}
        {...(now === undefined ? {} : { now })}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
