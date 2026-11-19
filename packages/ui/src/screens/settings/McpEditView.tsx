import type { McpServerStatus } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { McpAddForm } from "./McpAddForm.tsx";
import { SectionSkeleton } from "./shared.tsx";
import { type McpState, useMcpConfig } from "./use-mcp.tsx";

/**
 * Editing a tool server that is already added: the Add form, prefilled from the stored config.
 * Secrets show "Saved" and never a value. Save runs `mcp.update`: a new name applies at once;
 * a new command, address, domain or secret is probed and waits for the trust card, and the
 * current server keeps running until it is approved.
 */
export function McpEditView({
  server,
  mcp,
  onCancel,
}: {
  server: McpServerStatus;
  mcp: McpState;
  onCancel: () => void;
}): ReactElement {
  const state = useMcpConfig(server.id);
  if (state.loading) return <SectionSkeleton label={t("settings.mcp.edit.group")} rows={3} />;
  if (state.error !== null || state.config === null) {
    return (
      <p role="alert" className="text-callout text-danger-text">
        {t("settings.mcp.edit.loadFailed", { reason: state.error ?? "" })}
      </p>
    );
  }
  if (!state.config.editable) {
    return (
      <RenameOnly
        server={server}
        name={state.config.name}
        saving={mcp.checking}
        onSave={(name) => mcp.update(server, { name })}
        onCancel={onCancel}
      />
    );
  }
  return (
    <div hidden={mcp.review !== null}>
      <McpAddForm
        commandsAllowed={mcp.launcher !== "none"}
        checking={mcp.checking}
        onCheck={mcp.check}
        onCancel={onCancel}
        onSandboxReady={mcp.reload}
        edit={{
          config: state.config,
          onSave: (changes, secrets) => mcp.update(server, changes, secrets),
        }}
      />
    </div>
  );
}

/** A server whose command and connection are fixed: only its name can change. */
function RenameOnly({
  server,
  name,
  saving,
  onSave,
  onCancel,
}: {
  server: McpServerStatus;
  name: string;
  saving: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [value, setValue] = useState(name);
  const next = value.trim();
  return (
    <div className="flex flex-col gap-3" data-server={server.id}>
      <p className="text-callout text-label-secondary">{t("settings.mcp.edit.locked")}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>{t("settings.mcp.name")}</Label>
        <Input
          id={`${id}-name`}
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving || next === "" || next === name}
          onClick={() => onSave(next)}
        >
          {t("settings.mcp.edit.save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
