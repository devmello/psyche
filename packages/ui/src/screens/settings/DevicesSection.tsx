import type { Device, DeviceScope, NodeInfo, PairingRequest } from "@psyche/protocol";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { groupFingerprint } from "../../lib/fingerprint.ts";
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
import {
  type BundledHelperKey,
  DEV_FILE_KEY_SETTING,
  type PresenceKeyRow,
  presenceKeyText,
  TouchIdKeySetup,
} from "./TouchIdKeySetup.tsx";

/** Devices & nodes (UI design §3.18; architecture §7, §11; security §10). */

/** A device scope as the owner reads it ("Read", "Admin"). */
export const scopeLabel = (s: DeviceScope): string => t(`settings.devices.scope.${s}`);

const platformLabel = (p: Device["platform"]): string => t(`settings.devices.platform.${p}`);

/** Message ids for node kinds (ids are camelCase). */
const NODE_KIND_ID = {
  "mac-helper": "macHelper",
  "vm-guest": "vmGuest",
  remote: "remote",
  phone: "phone",
  // Linux L0 kinds. No Gateway emits them yet; a later Linux PR gives them their own labels.
  "host-helper": "macHelper",
  guest: "vmGuest",
} as const satisfies Record<NodeInfo["kind"], string>;

const nodeKindLabel = (k: NodeInfo["kind"]): string =>
  t(`settings.devices.nodeKind.${NODE_KIND_ID[k]}`);

/** Short, grouped fingerprint of a base64url public key, for comparing on both screens. */
export function keyFingerprint(publicKey: string): string {
  return (publicKey.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

export type { PresenceKeyRow } from "./TouchIdKeySetup.tsx";
export { presenceKeyText } from "./TouchIdKeySetup.tsx";

export interface DevicesPanelProps extends LoadProps {
  devices: readonly Device[];
  pairing: readonly PairingRequest[];
  nodes: readonly NodeInfo[];
  /** Registered helper Touch ID keys; each shows on its helper's row with its kind. */
  presenceKeys?: readonly PresenceKeyRow[];
  /** Touch ID key setup on each helper's row (absent: the keys are shown, nothing more). */
  touchId?: {
    bundled?: BundledHelperKey | null | undefined;
    allowDevFileKey: boolean;
    onRegister: (
      deviceId: string,
      expectKeyId?: string,
      confirmReplacesKeyId?: string,
    ) => Promise<unknown>;
    onRemove: (deviceId: string) => Promise<unknown>;
    onAllowDevFileKey: (on: boolean) => Promise<unknown>;
  };
  now?: number;
  thisDeviceId?: string;
  onApprove?: (request: PairingRequest, scopes: DeviceScope[]) => void;
  onDeny?: (request: PairingRequest) => void;
  onRevoke?: (device: Device) => void;
  actionError?: string | null;
  /** This Gateway's identity key fingerprint: compared with what the new computer shows. */
  gatewayFingerprint?: string;
}

export function DevicesPanel({
  devices,
  pairing,
  nodes,
  presenceKeys = [],
  touchId,
  now,
  thisDeviceId,
  onApprove,
  onDeny,
  onRevoke,
  actionError = null,
  gatewayFingerprint,
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
      title={t("settings.devices.title")}
      description={t("settings.devices.description")}
    >
      <LoadGate
        label={t("settings.devices.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {actionError ? (
          <ErrorNotice what={actionError} did={t("settings.shared.nothingChanged")} />
        ) : null}
        {pending.length > 0 ? (
          <Group
            title={t("settings.devices.waiting")}
            description={t("settings.devices.waitingHint")}
          >
            <ul className="flex flex-col gap-3">
              {pending.map((p) => (
                <PendingDevice
                  key={p.id}
                  request={p}
                  now={clock}
                  {...(gatewayFingerprint ? { gatewayFingerprint } : {})}
                  {...(onApprove ? { onApprove } : {})}
                  {...(onDeny ? { onDeny } : {})}
                />
              ))}
            </ul>
          </Group>
        ) : null}

        <Group title={t("settings.devices.paired")}>
          {active.length === 0 ? (
            <EmptyNotice text={t("settings.devices.noDevices")} />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {active.map((d) => (
                <li key={d.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    {d.id === thisDeviceId ? (
                      <StatusChip tone="accent">{t("settings.devices.thisDevice")}</StatusChip>
                    ) : null}
                    <span className="text-callout text-muted-foreground">
                      {t("settings.devices.platformRole", {
                        platform: platformLabel(d.platform),
                        role: d.role,
                      })}
                    </span>
                    {onRevoke && d.id !== thisDeviceId ? (
                      <span className="ms-auto">
                        <RowMoreMenu
                          name={d.name}
                          destructive={[
                            {
                              label: t("settings.devices.revoke"),
                              title: t("settings.devices.revokeTitle", { name: d.name }),
                              description: t("settings.devices.revokeDescription", {
                                name: d.name,
                              }),
                              confirm: t("settings.devices.revoke"),
                              onConfirm: () => onRevoke(d),
                            },
                          ]}
                        />
                      </span>
                    ) : null}
                  </div>
                  <ul
                    className="flex flex-wrap gap-1"
                    aria-label={t("settings.devices.scopesOf", { name: d.name })}
                  >
                    {d.scopes.map((s) => (
                      <li key={s}>
                        <StatusChip tone={s === "operator.admin" ? "approval" : "neutral"}>
                          {scopeLabel(s)}
                        </StatusChip>
                      </li>
                    ))}
                  </ul>
                  {d.id === thisDeviceId &&
                  d.platform === "macos" &&
                  d.scopes.includes("operator.admin") ? (
                    <p className="text-sm" data-testid="this-mac-admin">
                      {t("settings.devices.thisMacAdmin")}
                    </p>
                  ) : null}
                  <p className="text-callout text-muted-foreground">
                    {t("settings.devices.key")}{" "}
                    <code className="font-mono">{keyFingerprint(d.publicKey)}</code>{" "}
                    {d.lastSeenAt
                      ? t("settings.devices.keyLastSeen", {
                          when: formatRelative(d.lastSeenAt, clock),
                        })
                      : t("settings.devices.keyLastSeenNever")}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {revoked.length > 0 ? (
            <details className="text-callout text-muted-foreground">
              <summary className="cursor-pointer">
                {t("settings.devices.revoked", { n: revoked.length })}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {revoked.map((d) => (
                  <li key={d.id}>
                    {t("settings.devices.revokedItem", {
                      name: d.name,
                      when: d.revokedAt ? formatRelative(d.revokedAt, clock) : "",
                    })}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Group>

        <Group title={t("settings.devices.nodes")} description={t("settings.devices.nodesHint")}>
          {nodes.length === 0 ? (
            <EmptyNotice text={t("settings.devices.noNodes")} />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {nodes.map((n) => (
                <li key={n.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{nodeKindLabel(n.kind)}</span>
                    <span className="text-callout text-muted-foreground">
                      {t("settings.devices.onDevice", { device: deviceName(n.deviceId) })}
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
                      {t("settings.devices.nodeStatus", { status: n.status })}
                    </StatusChip>
                    <span className="text-callout text-muted-foreground">
                      {n.lastHeartbeatAt
                        ? t("settings.devices.lastSeen", {
                            when: formatRelative(n.lastHeartbeatAt, clock),
                          })
                        : t("settings.devices.lastSeenNever")}
                    </span>
                  </div>
                  {n.kind === "mac-helper" && touchId ? (
                    <TouchIdKeySetup
                      deviceId={n.deviceId}
                      registered={presenceKeys.find((k) => k.deviceId === n.deviceId)}
                      bundled={touchId.bundled}
                      allowDevFileKey={touchId.allowDevFileKey}
                      onRegister={(expect, confirm) =>
                        touchId.onRegister(n.deviceId, expect, confirm)
                      }
                      onRemove={() => touchId.onRemove(n.deviceId)}
                      onAllowDevFileKey={touchId.onAllowDevFileKey}
                    />
                  ) : (
                    presenceKeys
                      .filter((k) => k.deviceId === n.deviceId)
                      .map((k) => (
                        <p
                          key={k.keyId}
                          className="text-callout text-muted-foreground"
                          data-testid="presence-key"
                        >
                          {presenceKeyText(k)}
                        </p>
                      ))
                  )}
                  <ul
                    className="flex flex-wrap gap-1"
                    aria-label={t("settings.devices.capabilitiesOf", {
                      kind: nodeKindLabel(n.kind),
                    })}
                  >
                    {n.capabilities.map((c) => (
                      <li key={c.name}>
                        <code className="rounded bg-gray-4 px-1 font-mono text-callout">
                          {c.name}
                        </code>
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

/**
 * A request that came in over the network, not from the Mac's own sockets. Every pending
 * request on the WebSocket is one: the desktop on this Mac pairs by the handshake secret and
 * never waits here, so a request from 127.0.0.1 is an SSH tunnel, not this Mac.
 */
function isRemoteRequest(request: PairingRequest): boolean {
  return request.transport === "ws";
}

/**
 * What a new device starts with ticked. A computer on another network gets read, write and
 * approvals (design §3.5); admin is always an opt-in, and Touch ID still guards each admin change.
 */
export function defaultPairScopes(request: PairingRequest): DeviceScope[] {
  return isRemoteRequest(request)
    ? ["operator.read", "operator.write", "operator.approvals"]
    : ["operator.read", "operator.write"];
}

function PendingDevice({
  request,
  now,
  gatewayFingerprint,
  onApprove,
  onDeny,
}: {
  request: PairingRequest;
  now: number;
  gatewayFingerprint?: string;
  onApprove?: (request: PairingRequest, scopes: DeviceScope[]) => void;
  onDeny?: (request: PairingRequest) => void;
}): ReactElement {
  const id = useId();
  const [scopes, setScopes] = useState<DeviceScope[]>(() => defaultPairScopes(request));
  const remote = isRemoteRequest(request);
  // The Host marks a request that came in on its network listener in the card text.
  const lan = request.display.includes("on the local network");
  const toggle = (s: DeviceScope, on: boolean) =>
    setScopes((prev) => (on ? [...prev, s] : prev.filter((x) => x !== s)));
  return (
    <li className="flex flex-col gap-2">
      <p>
        <span className="font-medium">{request.display}</span> {t("settings.devices.wantsToPair")}{" "}
        <code className="rounded bg-gray-4 px-1 font-mono text-base tracking-wider">
          {request.code}
        </code>
        <span className="text-callout text-muted-foreground">
          {" "}
          {t("settings.devices.expires", { when: formatRelative(request.expiresAt, now) })}
        </span>
      </p>
      {remote ? (
        <p className="text-callout text-label-secondary">
          {t(lan ? "settings.devices.fromLan" : "settings.devices.fromAddress", {
            address: request.remoteAddress ?? "?",
          })}
        </p>
      ) : null}
      {remote && gatewayFingerprint ? (
        <p className="text-callout text-label-secondary">
          {t("settings.devices.gatewayKey", {
            // From the local network the key is the only proof of who answered: show all of it.
            fingerprint: lan
              ? (gatewayFingerprint
                  .replace(/^sha256:/, "")
                  .match(/.{1,4}/g)
                  ?.join(" ") ?? gatewayFingerprint)
              : groupFingerprint(gatewayFingerprint),
          })}
        </p>
      ) : null}
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="mb-1 text-callout text-muted-foreground">
          {t("settings.devices.scopesFor", { name: request.display })}
        </legend>
        {PAIR_SCOPES.map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <Checkbox
              id={`${id}-${s}`}
              checked={scopes.includes(s)}
              onCheckedChange={(v) => toggle(s, v === true)}
            />
            <Label htmlFor={`${id}-${s}`} className="font-normal">
              {scopeLabel(s)}
            </Label>
          </div>
        ))}
      </fieldset>
      {remote ? (
        <p className="text-callout text-label-secondary">{t("settings.devices.adminOptIn")}</p>
      ) : null}
      <div className="flex gap-2">
        {onApprove ? (
          <Button
            type="button"
            size="sm"
            disabled={scopes.length === 0}
            onClick={() => onApprove(request, scopes)}
            aria-label={t("settings.channels.approveSender", { name: request.display })}
          >
            {t("settings.channels.approve")}
          </Button>
        ) : null}
        {onDeny ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onDeny(request)}
            aria-label={t("settings.devices.denyNamed", { name: request.display })}
          >
            {t("settings.devices.deny")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

type DeviceAction = "approve" | "deny" | "revoke";

function deviceActionError(action: DeviceAction, err: unknown): string {
  return hasCode(err, "forbidden")
    ? t("settings.devices.err.forbidden", { action })
    : t("settings.devices.err.failed", { action, reason: messageOf(err) });
}

export function DevicesSection({
  now,
  thisDeviceId,
  touchId,
}: {
  now?: number;
  thisDeviceId?: string;
  /**
   * The desktop's Touch ID channels: what the helper bundled with this app reports, and
   * registering exactly that key. Absent on the web, where the owner types the key id.
   */
  touchId?: {
    identity(): Promise<BundledHelperKey | null>;
    register(confirmReplacesKeyId?: string): Promise<unknown>;
  };
}): ReactElement {
  const call = useCall();
  const devSettingQ = useGatewayQuery("settings.get", { keys: [DEV_FILE_KEY_SETTING] });
  const [bundled, setBundled] = useState<BundledHelperKey | null | undefined>(undefined);
  useEffect(() => {
    if (!touchId) return;
    let live = true;
    void touchId.identity().then(
      (id) => live && setBundled(id),
      () => live && setBundled(null),
    );
    return () => {
      live = false;
    };
  }, [touchId]);
  const devicesQ = useGatewayQuery("devices.list", { includeRevoked: true });
  const pairingQ = useGatewayQuery("devices.pairing.list", { status: "pending" });
  const nodesQ = useGatewayQuery("nodes.list", {});
  const infoQ = useGatewayQuery(
    "gateway.info",
    {},
    {
      enabled: (pairingQ.data?.pairingRequests ?? []).some((p) => p.status === "pending"),
    },
  );
  const keysQ = useGatewayQuery("devices.presenceKey.list", {});
  const settled = (p: Promise<unknown>) =>
    p.then((v) => {
      keysQ.reload();
      devSettingQ.reload();
      return v;
    });
  const [actionError, setActionError] = useState<string | null>(null);
  const reloadAll = useCallback(() => {
    devicesQ.reload();
    pairingQ.reload();
    nodesQ.reload();
    keysQ.reload();
  }, [devicesQ.reload, pairingQ.reload, nodesQ.reload, keysQ.reload]);

  const run = (action: DeviceAction, p: Promise<unknown>) => {
    setActionError(null);
    p.then(reloadAll, (err: unknown) => setActionError(deviceActionError(action, err)));
  };

  return (
    <DevicesPanel
      devices={devicesQ.data?.devices ?? []}
      pairing={pairingQ.data?.pairingRequests ?? []}
      nodes={nodesQ.data?.nodes ?? []}
      presenceKeys={keysQ.data?.presenceKeys ?? []}
      {...(infoQ.data ? { gatewayFingerprint: infoQ.data.identity.fingerprint } : {})}
      touchId={{
        bundled: touchId ? bundled : undefined,
        allowDevFileKey: devSettingQ.data?.settings?.[DEV_FILE_KEY_SETTING] === true,
        onRegister: (deviceId, expectKeyId, confirmReplacesKeyId) =>
          settled(
            touchId && expectKeyId === undefined
              ? touchId.register(confirmReplacesKeyId)
              : call("devices.presenceKey.register", {
                  deviceId,
                  expectKeyId: expectKeyId ?? "",
                  ...(confirmReplacesKeyId === undefined ? {} : { confirmReplacesKeyId }),
                }),
          ),
        onRemove: (deviceId) => settled(call("devices.presenceKey.remove", { deviceId })),
        onAllowDevFileKey: (on) =>
          settled(call("settings.set", { key: DEV_FILE_KEY_SETTING, value: on })),
      }}
      loading={devicesQ.loading && devicesQ.data === undefined}
      error={devicesQ.error ?? nodesQ.error}
      onRetry={reloadAll}
      actionError={
        actionError ??
        (pairingQ.error ? t("settings.channels.pairingFailed", { reason: pairingQ.error }) : null)
      }
      onApprove={(r, scopes) =>
        run("approve", call("devices.approve", { pairingRequestId: r.id, scopes }))
      }
      onDeny={(r) => run("deny", call("devices.deny", { pairingRequestId: r.id }))}
      onRevoke={(d) => run("revoke", call("devices.revoke", { deviceId: d.id }))}
      {...(now === undefined ? {} : { now })}
      {...(thisDeviceId === undefined ? {} : { thisDeviceId })}
    />
  );
}
