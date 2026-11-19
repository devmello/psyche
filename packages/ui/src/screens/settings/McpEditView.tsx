import type { McpServerStatus } from "@psyche/protocol";
import type { ReactElement } from "react";
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
    return <p className="text-callout text-label-secondary">{t("settings.mcp.edit.locked")}</p>;
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
