import type { Device, DeviceScope, NodeInfo, PairingRequest } from "@psyche/protocol";
import { type ReactElement, useCallback, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import {
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  LoadGate,
  type LoadProps,
  messageOf,
  SectionFrame,
  StatusChip,
} from "./shared.tsx";

/** Devices & nodes (UI design §3.18; architecture §7, §11; security §10). */

export const SCOPE_LABEL: Record<DeviceScope, string> = {
  "operator.read": "Read",
  "operator.write": "Write",
  "operator.approvals": "Approvals",
  "operator.admin": "Admin",
  node: "Node",
};

const PLATFORM: Record<Device["platform"], string> = {
  macos: "Mac",
  ios: "iPhone or iPad",
  android: "Android",
  web: "Web browser",
  linux: "Linux",
};

const NODE_KIND: Record<NodeInfo["kind"], string> = {
  "mac-helper": "Mac helper",
  "vm-guest": "VM guest",
  remote: "Remote node",
  phone: "Phone",
};

/** Short, grouped fingerprint of a base64url public key, for comparing on both screens. */
export function keyFingerprint(publicKey: string): string {
  return (publicKey.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

export interface DevicesPanelProps extends LoadProps {
  devices: readonly Device[];
  pairing: readonly PairingRequest[];
  nodes: readonly NodeInfo[];
  now?: number;
  thisDeviceId?: string;
  onApprove?: (request: PairingRequest, scopes: DeviceScope[]) => void;
  onDeny?: (request: PairingRequest) => void;
  onRevoke?: (device: Device) => void;
  actionError?: string | null;
}

export function DevicesPanel({
  devices,
  pairing,
  nodes,
  now,
  thisDeviceId,
  onApprove,
  onDeny,
  onRevoke,
  actionError = null,
  loading,
  error,
  onRetry,
}: DevicesPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const active = devices.filter((d) => d.revokedAt === null);
  const revoked = devices.filter((d) => d.revokedAt !== null);
  const pending = pairing.filter((p) => p.kind === "device" && p.status === "pending");
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? id;

  return (
    <SectionFrame
      title="Devices & nodes"
      description="Devices that can reach this Gateway, and the nodes that give it hands."
    >
      <LoadGate
        label="devices"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {actionError ? <ErrorNotice what={actionError} did="Nothing was changed." /> : null}
        {pending.length > 0 ? (
          <Group
            title="Waiting to pair"
            description="Approve only if the same code shows on the other device."
            className="border-approval-border bg-approval-surface"
          >
            <ul className="flex flex-col gap-3">
              {pending.map((p) => (
                <PendingDevice
                  key={p.id}
                  request={p}
                  now={clock}
                  {...(onApprove ? { onApprove } : {})}
                  {...(onDeny ? { onDeny } : {})}
                />
              ))}
            </ul>
          </Group>
        ) : null}

        <Group title="Paired devices">
          {active.length === 0 ? (
            <EmptyNotice text="No devices paired. Open Psyche on another device to pair it." />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {active.map((d) => (
                <li key={d.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    {d.id === thisDeviceId ? (
                      <StatusChip tone="accent">This device</StatusChip>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {PLATFORM[d.platform]} · {d.role === "both" ? "client and node" : d.role}
                    </span>
                    {onRevoke && d.id !== thisDeviceId ? (
                      <span className="ml-auto">
                        <RowMoreMenu
                          name={d.name}
                          destructive={[
                            {
                              label: "Revoke",
                              title: `Revoke ${d.name}?`,
                              description: `${d.name} is signed out of this Gateway at once and has to pair again to come back.`,
                              confirm: "Revoke",
                              onConfirm: () => onRevoke(d),
                            },
                          ]}
                        />
                      </span>
                    ) : null}
                  </div>
                  <ul className="flex flex-wrap gap-1" aria-label={`${d.name} scopes`}>
                    {d.scopes.map((s) => (
                      <li key={s}>
                        <StatusChip tone={s === "operator.admin" ? "approval" : "neutral"}>
                          {SCOPE_LABEL[s]}
                        </StatusChip>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    Key <code className="font-mono">{keyFingerprint(d.publicKey)}</code> · last seen{" "}
                    {d.lastSeenAt ? formatRelative(d.lastSeenAt, clock) : "never"}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {revoked.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Revoked ({revoked.length})</summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {revoked.map((d) => (
                  <li key={d.id}>
                    {d.name}, revoked {d.revokedAt ? formatRelative(d.revokedAt, clock) : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Group>

        <Group
          title="Nodes"
          description="Capabilities each node offers. Every call still goes through your permissions."
        >
          {nodes.length === 0 ? (
            <EmptyNotice text="No nodes. The Mac helper appears here once Psyche runs on a Mac." />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {nodes.map((n) => (
                <li key={n.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{NODE_KIND[n.kind]}</span>
                    <span className="text-xs text-muted-foreground">
                      on {deviceName(n.deviceId)}
                    </span>
                    <StatusChip
                      tone={
                        n.status === "online"
                          ? "success"
                          : n.status === "degraded"
                            ? "approval"
                            : "neutral"
                      }
                    >
                      {n.status === "online"
                        ? "Online"
                        : n.status === "degraded"
                          ? "Degraded"
                          : "Offline"}
                    </StatusChip>
                    <span className="text-xs text-muted-foreground">
                      last seen{" "}
                      {n.lastHeartbeatAt ? formatRelative(n.lastHeartbeatAt, clock) : "never"}
                    </span>
                  </div>
                  <ul
                    className="flex flex-wrap gap-1"
                    aria-label={`${NODE_KIND[n.kind]} capabilities`}
                  >
                    {n.capabilities.map((c) => (
                      <li key={c.name}>
                        <code className="rounded bg-gray-4 px-1 font-mono text-xs">{c.name}</code>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

const PAIR_SCOPES: readonly DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
  "node",
];

function PendingDevice({
  request,
  now,
  onApprove,
  onDeny,
}: {
  request: PairingRequest;
  now: number;
  onApprove?: (request: PairingRequest, scopes: DeviceScope[]) => void;
  onDeny?: (request: PairingRequest) => void;
}): ReactElement {
  const id = useId();
  const [scopes, setScopes] = useState<DeviceScope[]>(["operator.read", "operator.write"]);
  const toggle = (s: DeviceScope, on: boolean) =>
    setScopes((prev) => (on ? [...prev, s] : prev.filter((x) => x !== s)));
  return (
    <li className="flex flex-col gap-2">
      <p>
        <span className="font-medium">{request.display}</span> wants to pair. Challenge{" "}
        <code className="rounded bg-gray-4 px-1 font-mono text-base tracking-wider">
          {request.code}
        </code>
        <span className="text-xs text-muted-foreground">
          {" "}
          · expires {formatRelative(request.expiresAt, now)}
        </span>
      </p>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="mb-1 text-xs text-muted-foreground">Scopes for {request.display}</legend>
        {PAIR_SCOPES.map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <Checkbox
              id={`${id}-${s}`}
              checked={scopes.includes(s)}
              onCheckedChange={(v) => toggle(s, v === true)}
            />
            <Label htmlFor={`${id}-${s}`} className="font-normal">
              {SCOPE_LABEL[s]}
            </Label>
          </div>
        ))}
      </fieldset>
      <div className="flex gap-2">
        {onApprove ? (
          <Button
            type="button"
            size="sm"
            disabled={scopes.length === 0}
            onClick={() => onApprove(request, scopes)}
            aria-label={`Approve ${request.display}`}
          >
            Approve
          </Button>
        ) : null}
        {onDeny ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onDeny(request)}
            aria-label={`Deny ${request.display}`}
          >
            Deny
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function deviceActionError(what: string, err: unknown): string {
  return hasCode(err, "forbidden")
    ? `${what} needs approval on this device. Use a device paired as admin.`
    : `Psyche couldn't ${what.toLowerCase()} (${messageOf(err)}).`;
}

export function DevicesSection({
  now,
  thisDeviceId,
}: {
  now?: number;
  thisDeviceId?: string;
}): ReactElement {
  const call = useCall();
  const devicesQ = useGatewayQuery("devices.list", { includeRevoked: true });
  const pairingQ = useGatewayQuery("devices.pairing.list", { status: "pending" });
  const nodesQ = useGatewayQuery("nodes.list", {});
  const [actionError, setActionError] = useState<string | null>(null);
  const reloadAll = useCallback(() => {
    devicesQ.reload();
    pairingQ.reload();
    nodesQ.reload();
  }, [devicesQ.reload, pairingQ.reload, nodesQ.reload]);

  const run = (what: string, p: Promise<unknown>) => {
    setActionError(null);
    p.then(reloadAll, (err: unknown) => setActionError(deviceActionError(what, err)));
  };

  return (
    <DevicesPanel
      devices={devicesQ.data?.devices ?? []}
      pairing={pairingQ.data?.pairingRequests ?? []}
      nodes={nodesQ.data?.nodes ?? []}
      loading={devicesQ.loading && devicesQ.data === undefined}
      error={devicesQ.error ?? nodesQ.error}
      onRetry={reloadAll}
      actionError={
        actionError ??
        (pairingQ.error ? `Psyche couldn't load pairing requests (${pairingQ.error}).` : null)
      }
      onApprove={(r, scopes) =>
        run("Approve pairing", call("devices.approve", { pairingRequestId: r.id, scopes }))
      }
      onDeny={(r) => run("Deny pairing", call("devices.deny", { pairingRequestId: r.id }))}
      onRevoke={(d) => run("Revoke the device", call("devices.revoke", { deviceId: d.id }))}
      {...(now === undefined ? {} : { now })}
      {...(thisDeviceId === undefined ? {} : { thisDeviceId })}
    />
  );
}
