import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpServerSecret, McpServerStatus, McpServerTool } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { t } from "../../i18n/core.ts";
import { Group, SectionSkeleton, StatusChip, type Tone } from "./shared.tsx";
import {
  type McpSecretsState,
  type McpToolsState,
  useMcpSecrets,
  useMcpTools,
} from "./use-mcp.tsx";

/**
 * What an added server's detail lets the owner do: choose which of its tools the agent is
 * offered, replace its secrets (by name; a value never comes back), and turn it off or remove it.
 * Settings → Connectors → a server → Show details.
 */

const show = (s: string, max = 200) => sanitizeDisplay(s, max);

const SIDE_EFFECT: Record<NonNullable<McpServerTool["sideEffect"]>, Tone> = {
  read: "success",
  write: "approval",
  destructive: "danger",
};

function ToolRow({
  tool,
  busy,
  onChange,
}: {
  tool: McpServerTool;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <code id={`${id}-name`} className="text-body text-label-primary">
            {show(tool.name, 80)}
          </code>
          {tool.sideEffect ? (
            <StatusChip tone={SIDE_EFFECT[tool.sideEffect]}>
              {t(`settings.mcp.tier.${tool.sideEffect}`)}
            </StatusChip>
          ) : null}
          {tool.blocked ? (
            <StatusChip tone="danger">{t("settings.mcp.trust.blocked")}</StatusChip>
          ) : null}
        </div>
        {tool.description !== "" ? (
          <p className="text-callout text-label-secondary">{show(tool.description)}</p>
        ) : null}
      </div>
      <Switch
        aria-labelledby={`${id}-name`}
        checked={tool.enabled && !tool.blocked}
        disabled={busy || tool.blocked}
        onCheckedChange={(v) => onChange(v)}
      />
    </div>
  );
}

export function McpToolsGroup({
  server,
  state,
}: {
  server: McpServerStatus;
  state: McpToolsState;
}): ReactElement {
  const live = server.connected && server.enabled !== false;
  const offCount = state.tools.filter((x) => !x.enabled || x.blocked).length;
  return (
    <Group
      title={t("settings.mcp.tools.title")}
      description={
        live && state.tools.length > 0 ? t("settings.mcp.tools.hint", { off: offCount }) : undefined
      }
    >
      {state.loading ? (
        <SectionSkeleton label={t("settings.mcp.tools.title")} rows={2} />
      ) : state.error !== null ? (
        <p role="alert" className="text-callout text-danger-text">
          {t("settings.mcp.tools.loadFailed", { reason: state.error })}
        </p>
      ) : !live || !state.available ? (
        <p className="text-callout text-label-secondary">
          {server.enabled === false
            ? t("settings.mcp.tools.off")
            : t("settings.mcp.tools.notConnected")}
        </p>
      ) : state.tools.length === 0 ? (
        <p className="text-callout text-label-secondary">{t("settings.mcp.tools.none")}</p>
      ) : (
        state.tools.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            busy={state.busy === tool.name}
            onChange={(enabled) => state.set(tool.name, enabled)}
          />
        ))
      )}
      {state.actionError !== null ? (
        <p role="alert" className="text-callout text-danger-text">
          {state.actionError}
        </p>
      ) : null}
    </Group>
  );
}

function SecretRow({
  secret,
  busy,
  onReplace,
}: {
  secret: McpServerSecret;
  busy: boolean;
  onReplace: (value: string) => Promise<boolean>;
}): ReactElement {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const done = () => {
    setEditing(false);
    setValue("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 text-body text-label-primary">{show(secret.name, 80)}</code>
        <StatusChip tone={secret.isSet ? "success" : "approval"}>
          {secret.isSet ? t("settings.mcp.secrets.set") : t("settings.mcp.secrets.unset")}
        </StatusChip>
        {editing ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("settings.mcp.secrets.replaceFor", { name: secret.name })}
            onClick={() => setEditing(true)}
          >
            {secret.isSet ? t("settings.mcp.secrets.replace") : t("settings.mcp.secrets.setIt")}
          </Button>
        )}
      </div>
      {secret.storage === "config" && secret.isSet ? (
        <p className="text-callout text-label-secondary">{t("settings.mcp.secrets.plain")}</p>
      ) : null}
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value === "") return;
            void onReplace(value).then((ok) => {
              if (ok) done();
            });
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor={`${id}-value`}>
              {t("settings.mcp.secrets.newValue", { name: secret.name })}
            </Label>
            <Input
              id={`${id}-value`}
              type="password"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby={`${id}-hint`}
            />
            <p id={`${id}-hint`} className="text-caption text-label-secondary">
              {t("settings.mcp.secrets.hint")}
            </p>
          </div>
          <Button type="submit" size="sm" disabled={value === "" || busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={done}>
            {t("common.cancel")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export function McpSecretsGroup({ state }: { state: McpSecretsState }): ReactElement | null {
  if (!state.loading && state.error === null && state.secrets.length === 0) return null;
  return (
    <Group title={t("settings.mcp.secrets.title")} description={t("settings.mcp.secrets.intro")}>
      {state.loading ? (
        <SectionSkeleton label={t("settings.mcp.secrets.title")} rows={1} />
      ) : state.error !== null ? (
        <p role="alert" className="text-callout text-danger-text">
          {t("settings.mcp.secrets.loadFailed", { reason: state.error })}
        </p>
      ) : (
        state.secrets.map((s) => (
          <SecretRow
            key={s.name}
            secret={s}
            busy={state.busy === s.name}
            onReplace={(value) => state.replace(s.name, value)}
          />
        ))
      )}
      {state.actionError !== null ? (
        <p role="alert" className="text-callout text-danger-text">
          {state.actionError}
        </p>
      ) : null}
      {state.notice !== null ? (
        <p role="status" className="text-callout text-label-secondary">
          {state.notice}
        </p>
      ) : null}
    </Group>
  );
}

function ConfirmRemove({
  server,
  onConfirm,
}: {
  server: McpServerStatus;
  onConfirm: () => void;
}): ReactElement {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => setAsking(true)}>
        {t("common.remove")}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.mcp.removeTitle", { name: show(server.name, 64) })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("settings.mcp.removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setAsking(false);
                onConfirm();
              }}
            >
              {t("common.remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function McpDangerZone({
  server,
  onSetEnabled,
  onRemove,
}: {
  server: McpServerStatus;
  onSetEnabled?: (enabled: boolean) => void;
  onRemove?: () => void;
}): ReactElement | null {
  if (!onSetEnabled && !onRemove) return null;
  const on = server.enabled !== false;
  return (
    <Group title={t("settings.mcp.danger.title")}>
      {onSetEnabled ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-body text-label-primary">
              {on ? t("settings.mcp.danger.disable") : t("settings.mcp.danger.enable")}
            </p>
            <p className="text-callout text-label-secondary">
              {on ? t("settings.mcp.danger.disableHint") : t("settings.mcp.danger.enableHint")}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => onSetEnabled(!on)}>
            {on ? t("settings.mcp.danger.disableAction") : t("settings.mcp.danger.enableAction")}
          </Button>
        </div>
      ) : null}
      {onRemove ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-body text-label-primary">{t("settings.mcp.danger.remove")}</p>
            <p className="text-callout text-label-secondary">
              {t("settings.mcp.danger.removeHint")}
            </p>
          </div>
          <ConfirmRemove server={server} onConfirm={onRemove} />
        </div>
      ) : null}
    </Group>
  );
}

/** Tools, Secrets and the Danger zone of one server (loads only while its details are open). */
export function McpServerPanels({
  server,
  onSetEnabled,
  onRemove,
}: {
  server: McpServerStatus;
  onSetEnabled?: (enabled: boolean) => void;
  onRemove?: () => void;
}): ReactElement {
  const tools = useMcpTools(server, true);
  const secrets = useMcpSecrets(server, true);
  return (
    <div className="ms-11 flex flex-col gap-4">
      <McpToolsGroup server={server} state={tools} />
      <McpSecretsGroup state={secrets} />
      <McpDangerZone
        server={server}
        {...(onSetEnabled ? { onSetEnabled } : {})}
        {...(onRemove ? { onRemove } : {})}
      />
    </div>
  );
}
