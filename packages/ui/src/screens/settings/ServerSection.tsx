import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useSlots } from "../../slots.tsx";
import { GatewaysGroup } from "./GatewaysGroup.tsx";
import { LanAccessGroup } from "./LanAccessGroup.tsx";
import { RemoteAccessGroup } from "./RemoteAccessGroup.tsx";
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

const remoteLabel = (kind: NonNullable<ServerStatus["remote"]>["kind"]): string =>
  t(`settings.server.remote.${kind}`);

export interface ServerPanelProps extends SettingsFormProps, LoadProps {
  status: ServerStatus | null;
  sandboxError?: string | null;
  onAddPasskey?: () => void;
  onSetUpRemote?: () => void;
}

export function ServerPanel({
  values,
  onChange,
  needsApproval,
  status,
  sandboxError = null,
  onAddPasskey,
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
              <p className="text-callout text-approval-text" role="status">
                {t("settings.server.exposed")}
              </p>
            ) : null}
          </TextSetting>
        </Group>

        <Group
          title={t("settings.server.remoteAccess")}
          actions={
            onSetUpRemote && (status?.remote?.kind ?? "none") === "none" ? (
              <Button type="button" size="sm" variant="outline" onClick={onSetUpRemote}>
                {t("settings.server.setUp")}
              </Button>
            ) : null
          }
        >
          {status?.remote === undefined ? (
            <EmptyNotice text={t("settings.server.remoteUnknown")} />
          ) : null}
          {status === null ? null : (
            <Facts
              items={[
                ...(status.remote === undefined
                  ? []
                  : [
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
                                {t("settings.server.remoteStatus", {
                                  status: status.remote.status,
                                })}
                              </StatusChip>
                            )}
                          </span>
                        ),
                      },
                      ...(status.remote.url
                        ? [
                            {
                              term: t("settings.server.address"),
                              value: (
                                <code className="font-mono text-callout">{status.remote.url}</code>
                              ),
                            },
                          ]
                        : []),
                    ]),
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
              <code className="font-mono text-callout">{status.sandbox.backend}</code>
              <StatusChip tone={status.sandbox.available ? "success" : "danger"}>
                {status.sandbox.available
                  ? t("settings.server.available")
                  : t("settings.server.unavailable")}
              </StatusChip>
              {status.sandbox.available ? null : (
                <span className="text-callout text-danger-text">
                  {t("settings.server.noBackend")}
                </span>
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("settings.server.checkingSandbox")}</p>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

/** Settings → Devices → Server & remote access: how other devices reach the Gateway. */
const REMOTE_DOCS = "https://devmello.github.io/psyche/get-started/server-mode#reach-it-safely";

export interface ServerSectionProps {
  /** Remote access and passkeys as the shell knows them; otherwise read from the Gateway. */
  status?: ServerStatus;
  onAddPasskey?: () => void;
  onSetUpRemote?: () => void;
}

export function ServerSection({ status, ...actions }: ServerSectionProps): ReactElement {
  const form = useSettingsForm();
  const { openExternal, remoteHost } = useSlots();
  const sandbox = useGatewayQuery("sandbox.status", {});
  const passkeys = useGatewayQuery("passkeys.list", {});
  const sandboxNow = sandbox.data
    ? { backend: sandbox.data.backend, available: sandbox.data.available }
    : null;
  // No Gateway method reports remote access, so without the shell's status it says so plainly.
  const merged: ServerStatus = status
    ? { ...status, sandbox: sandboxNow ?? status.sandbox }
    : {
        bind: str(form.values, "gateway.bind", DEFAULT_BIND),
        passkeys: passkeys.data?.passkeys.length ?? 0,
        sandbox: sandboxNow,
        vm: null,
      };
  const onSetUpRemote =
    actions.onSetUpRemote ??
    (() => {
      if (openExternal) void openExternal(REMOTE_DOCS).catch(() => undefined);
      else globalThis.open?.(REMOTE_DOCS, "_blank", "noopener,noreferrer");
    });
  return (
    <div className="flex flex-col gap-3">
      <GatewaysGroup />
      {remoteHost === undefined ? (
        <>
          <RemoteAccessGroup />
          <LanAccessGroup />
        </>
      ) : (
        <p className="text-callout text-label-secondary">
          {t("settings.remote.clientNote", { host: remoteHost })}
        </p>
      )}
      <ServerPanel
        {...actions}
        onSetUpRemote={onSetUpRemote}
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
