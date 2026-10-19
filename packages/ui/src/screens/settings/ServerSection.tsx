import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { plural } from "../../lib/format.ts";
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

const REMOTE_LABEL: Record<ServerStatus["remote"]["kind"], string> = {
  none: "Not set up",
  tailscale: "Tailscale Serve",
  proxy: "Reverse proxy",
};

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
      title="Server & remote access"
      description="Where the Gateway listens and how your other devices reach it."
    >
      <LoadGate
        label="server status"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Gateway">
          <TextSetting
            label="Bind address"
            description="127.0.0.1 keeps it on this Mac. Use remote access below instead of binding to every interface."
            value={bind}
            settingKey="gateway.bind"
            onCommit={(v) => onChange("gateway.bind", v === "" ? DEFAULT_BIND : v)}
          >
            {exposed ? (
              <p className="text-xs text-approval-text" role="status">
                The Gateway is reachable from your network. Every device still has to pair.
              </p>
            ) : null}
          </TextSetting>
        </Group>

        <Group
          title="Remote access"
          actions={
            onSetUpRemote && (status?.remote.kind ?? "none") === "none" ? (
              <Button type="button" size="sm" variant="outline" onClick={onSetUpRemote}>
                Set up
              </Button>
            ) : null
          }
        >
          {status === null ? (
            <EmptyNotice text="Remote access status isn't available on this device." />
          ) : (
            <Facts
              items={[
                {
                  term: "Method",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {REMOTE_LABEL[status.remote.kind]}
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
                          {status.remote.status === "ok"
                            ? "Working"
                            : status.remote.status === "error"
                              ? "Error"
                              : "Off"}
                        </StatusChip>
                      )}
                    </span>
                  ),
                },
                ...(status.remote.url
                  ? [
                      {
                        term: "Address",
                        value: <code className="font-mono text-xs">{status.remote.url}</code>,
                      },
                    ]
                  : []),
                {
                  term: "Passkeys",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {plural(status.passkeys, "passkey")}
                      {onAddPasskey ? (
                        <Button type="button" variant="link" size="xs" onClick={onAddPasskey}>
                          Add a passkey
                        </Button>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Group>

        <Group
          title="Sandbox"
          description="Commands run in a container. Psyche never falls back to the host shell."
        >
          {sandboxError ? (
            <ErrorNotice
              what={`Psyche couldn't read sandbox health (${sandboxError}).`}
              did="Commands stay blocked until a backend reports in."
            />
          ) : status?.sandbox ? (
            <p className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{status.sandbox.backend}</code>
              <StatusChip tone={status.sandbox.available ? "success" : "danger"}>
                {status.sandbox.available ? "Available" : "Unavailable"}
              </StatusChip>
              {status.sandbox.available ? null : (
                <span className="text-xs text-danger-text">
                  No sandbox backend is available. Psyche never falls back to the host shell.
                </span>
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">Checking the sandbox.</p>
          )}
        </Group>

        <Group title="VM mode">
          {status?.vm == null || status.vm.state === "none" ? (
            <EmptyNotice text="No VM. VM mode runs Psyche inside a separate macOS guest; set it up from onboarding." />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{status.vm.name ?? "Guest"}</span>
              <StatusChip
                tone={
                  status.vm.state === "running"
                    ? "success"
                    : status.vm.state === "error"
                      ? "danger"
                      : "neutral"
                }
              >
                {status.vm.state === "running"
                  ? "Running"
                  : status.vm.state === "error"
                    ? "Error"
                    : "Stopped"}
              </StatusChip>
              {status.vm.state === "running" && onStopVm ? (
                <Button type="button" size="sm" variant="outline" onClick={onStopVm}>
                  Stop VM
                </Button>
              ) : null}
              {status.vm.state !== "running" && onStartVm ? (
                <Button type="button" size="sm" onClick={onStartVm}>
                  Start VM
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
