import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { EMPTY_DRAFT, type McpDraft, splitCommand } from "./mcp-input.ts";
import { RadioField } from "./shared.tsx";

/**
 * The "Custom MCP server" form inside Add connector (#529): a command (run sandboxed) or an HTTPS
 * URL. "Check server" probes it (`mcp.probe`); the trust card and its approval come next.
 */
export function McpAddForm({
  commandsAllowed,
  checking,
  onCheck,
  onCancel,
}: {
  commandsAllowed: boolean;
  checking: boolean;
  onCheck: (draft: McpDraft) => void;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [d, setD] = useState<McpDraft>({
    ...EMPTY_DRAFT,
    kind: commandsAllowed ? "command" : "url",
  });
  const ready =
    d.name.trim() !== "" &&
    (d.kind === "url" ? /^https:\/\/\S+$/.test(d.url.trim()) : splitCommand(d.command).length > 0);
  return (
    <>
      <p className="text-sm text-muted-foreground">{t("settings.mcp.addHint")}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>{t("settings.mcp.name")}</Label>
        <Input
          id={`${id}-name`}
          value={d.name}
          maxLength={100}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
      </div>
      <RadioField
        label={t("settings.mcp.how")}
        value={d.kind}
        onChange={(kind) => setD({ ...d, kind })}
        options={[
          {
            value: "command",
            label: t("settings.mcp.kind.command"),
            hint: commandsAllowed
              ? t("settings.mcp.kind.commandHint")
              : t("settings.mcp.kind.commandUnavailable"),
          },
          {
            value: "url",
            label: t("settings.mcp.kind.url"),
            hint: t("settings.mcp.kind.urlHint"),
          },
        ]}
      />
      {d.kind === "command" ? (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-cmd`}>{t("settings.mcp.command")}</Label>
            <Input
              id={`${id}-cmd`}
              className="font-mono"
              placeholder={t("settings.mcp.placeholder.command")}
              value={d.command}
              onChange={(e) => setD({ ...d, command: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-domains`}>{t("settings.mcp.domains")}</Label>
            <Input
              id={`${id}-domains`}
              placeholder={t("settings.mcp.placeholder.domains")}
              value={d.domains}
              onChange={(e) => setD({ ...d, domains: e.target.value })}
              aria-describedby={`${id}-domains-hint`}
            />
            <p id={`${id}-domains-hint`} className="text-xs text-muted-foreground">
              {t("settings.mcp.domainsHint")}
            </p>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-url`}>{t("settings.mcp.url")}</Label>
          <Input
            id={`${id}-url`}
            type="url"
            placeholder={t("settings.mcp.placeholder.url")}
            value={d.url}
            onChange={(e) => setD({ ...d, url: e.target.value })}
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!ready || checking || (d.kind === "command" && !commandsAllowed)}
          onClick={() => onCheck(d)}
        >
          {checking ? t("settings.mcp.checking") : t("settings.mcp.check")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </>
  );
}
