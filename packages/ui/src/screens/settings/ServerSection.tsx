import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import {
  EmptyNotice,
  ErrorNotice,
  Facts,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  type SettingsFormProps,
  StatusChip,
  str,
  TextSetting,
  useSettingsForm,
} from "./shared.tsx";
import type { ServerStatus } from "./types.ts";

/** Server & remote access (UI design §3.18; architecture §9–§11). */

const DEFAULT_BIND = `${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;

const remoteLabel = (kind: ServerStatus["remote"]["kind"]): string =>
  t(`settings.server.remote.${kind}`);

export interface ServerPanelProps extends SettingsFormProps, LoadProps {
  status: ServerStatus | null;
  sandboxError?: string | null;
  onAddPasskey?: () => void;
  onStartVm?: () => void;
  onStopVm?: () => void;
  onSetUpRemote?: () => void;
}

export function ServerPanel({
  values,
  onChange,
  needsApproval,
  status,
  sandboxError = null,
  onAddPasskey,
  onStartVm,
  onStopVm,
  onSetUpRemote,
  loading,
  error,
  onRetry,
}: ServerPanelProps): ReactElement {
  const bind = str(values, "gateway.bind", status?.bind ?? DEFAULT_BIND);
  const exposed = !bind.startsWith("127.0.0.1") && !bind.startsWith("localhost");
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.server.title")}
      description={t("settings.server.description")}
    >
      <LoadGate
        label={t("settings.server.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.about.gateway")}>
          <TextSetting
            label={t("settings.key.gateway.bind")}
            description={t("settings.server.bindHint")}
            value={bind}
            settingKey="gateway.bind"
            onCommit={(v) => onChange("gateway.bind", v === "" ? DEFAULT_BIND : v)}
          >
            {exposed ? (
              <p className="text-xs text-approval-text" role="status">
                {t("settings.server.exposed")}
              </p>
            ) : null}
          </TextSetting>
        </Group>

        <Group
          title={t("settings.server.remoteAccess")}
          actions={
            onSetUpRemote && (status?.remote.kind ?? "none") === "none" ? (
              <Button type="button" size="sm" variant="outline" onClick={onSetUpRemote}>
                {t("settings.server.setUp")}
              </Button>
            ) : null
          }
        >
          {status === null ? (
            <EmptyNotice text={t("settings.server.remoteUnknown")} />
          ) : (
            <Facts
              items={[
                {
                  term: t("settings.server.method"),
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {remoteLabel(status.remote.kind)}
                      {status.remote.kind === "none" ? null : (
                        <StatusChip
                          tone={
                            status.remote.status === "ok"
                              ? "success"
                              : status.remote.status === "error"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {t("settings.server.remoteStatus", { status: status.remote.status })}
                        </StatusChip>
                      )}
                    </span>
                  ),
                },
                ...(status.remote.url
                  ? [
                      {
                        term: t("settings.server.address"),
                        value: <code className="font-mono text-xs">{status.remote.url}</code>,
                      },
                    ]
                  : []),
                {
                  term: t("settings.server.passkeys"),
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {t("settings.server.passkeyCount", { n: status.passkeys })}
                      {onAddPasskey ? (
                        <Button type="button" variant="link" size="xs" onClick={onAddPasskey}>
                          {t("settings.server.addPasskey")}
                        </Button>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Group>

        <Group title={t("settings.server.sandbox")} description={t("settings.server.sandboxHint")}>
          {sandboxError ? (
            <ErrorNotice
              what={t("settings.server.sandboxFailed", { reason: sandboxError })}
              did={t("settings.server.sandboxBlocked")}
            />
          ) : status?.sandbox ? (
            <p className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{status.sandbox.backend}</code>
              <StatusChip tone={status.sandbox.available ? "success" : "danger"}>
                {status.sandbox.available
                  ? t("settings.server.available")
                  : t("settings.server.unavailable")}
              </StatusChip>
              {status.sandbox.available ? null : (
                <span className="text-xs text-danger-text">{t("settings.server.noBackend")}</span>
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("settings.server.checkingSandbox")}</p>
          )}
        </Group>

        <Group title={t("settings.nav.vm")}>
          {status?.vm == null || status.vm.state === "none" ? (
            <EmptyNotice text={t("settings.server.noVm")} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{status.vm.name ?? t("settings.server.guest")}</span>
              <StatusChip
                tone={
                  status.vm.state === "running"
                    ? "success"
                    : status.vm.state === "error"
                      ? "danger"
                      : "neutral"
                }
              >
                {t("settings.server.vmState", { state: status.vm.state })}
              </StatusChip>
              {status.vm.state === "running" && onStopVm ? (
                <Button type="button" size="sm" variant="outline" onClick={onStopVm}>
                  {t("settings.server.stopVm")}
                </Button>
              ) : null}
              {status.vm.state !== "running" && onStartVm ? (
                <Button type="button" size="sm" onClick={onStartVm}>
                  {t("settings.server.startVm")}
                </Button>
              ) : null}
            </div>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export interface ServerSectionProps {
  /** Remote access, passkeys and VM state come from the shell (no Gateway method yet). */
  status?: ServerStatus;
  onAddPasskey?: () => void;
  onStartVm?: () => void;
  onStopVm?: () => void;
  onSetUpRemote?: () => void;
}

export function ServerSection({ status, ...actions }: ServerSectionProps): ReactElement {
  const form = useSettingsForm();
  const sandbox = useGatewayQuery("sandbox.status", {});
  const merged: ServerStatus | null =
    status === undefined
      ? null
      : {
          ...status,
          sandbox: sandbox.data
            ? { backend: sandbox.data.backend, available: sandbox.data.available }
            : status.sandbox,
        };
  return (
    <div className="flex flex-col gap-3">
      <ServerPanel
        {...actions}
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        status={merged}
        sandboxError={sandbox.error}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
