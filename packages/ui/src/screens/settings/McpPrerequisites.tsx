import { type McpPreset, type PresetNeed, presetNeeds } from "@psyche/protocol";
import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { SandboxNotice } from "./SandboxNotice.tsx";
import { StatusChip } from "./shared.tsx";
import type { McpState } from "./use-mcp.tsx";

/**
 * What a preset needs on this Mac, with the fix next to each: the sandbox (one-click srt
 * install), Node tools (npx), uv (uvx), the network. Only the sandbox can be told ahead of time;
 * the runtimes are confirmed when the server is checked, and a miss says which.
 */
export function McpPrerequisites({
  preset,
  mcp,
}: {
  preset: McpPreset;
  mcp: Pick<McpState, "launcher" | "reload">;
}): ReactElement | null {
  const needs = presetNeeds(preset);
  if (needs.length === 0) return null;
  const hosts =
    preset.transport.kind === "stdio" ? (preset.transport.domains ?? []).join(", ") : "";
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-callout">
        <caption className="pb-1 text-start text-caption text-label-tertiary">
          {t("settings.mcp.needs.title")}
        </caption>
        <tbody className="divide-y divide-separator">
          {needs.map((need) => (
            <tr key={need}>
              <th scope="row" className="py-1.5 pe-3 text-start font-normal text-label-primary">
                {t(`settings.mcp.needs.${need}` as MessageId)}
              </th>
              <td className="py-1.5 pe-3 text-label-secondary">
                {need === "network" && hosts !== ""
                  ? t("settings.mcp.needs.networkHosts", { hosts })
                  : t(`settings.mcp.needs.${need}.fix` as MessageId)}
              </td>
              <td className="py-1.5 text-end">
                {need === "srt" ? (
                  <StatusChip tone={mcp.launcher === "none" ? "danger" : "success"}>
                    {mcp.launcher === "none"
                      ? t("settings.mcp.needs.missing")
                      : t("settings.mcp.needs.ready")}
                  </StatusChip>
                ) : (
                  <StatusChip tone="neutral">{t("settings.mcp.needs.checked")}</StatusChip>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {needs.includes("srt" as PresetNeed) && mcp.launcher === "none" ? (
        <SandboxNotice message={t("settings.mcp.kind.commandUnavailable")} onReady={mcp.reload} />
      ) : null}
    </div>
  );
}
