import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { EMPTY_DRAFT, type McpDraft, splitCommand, toServerInput } from "./mcp-input.ts";
import { type ImportedServer, type ImportResult, parseMcpJson, withImported } from "./mcp-json.ts";
import { SandboxNotice } from "./SandboxNotice.tsx";
import { RadioField } from "./shared.tsx";
import type { McpState } from "./use-mcp.tsx";

/**
 * The "Custom MCP server" form inside Add connector (#529): a command (run sandboxed) or an HTTPS
 * URL. "Check server" probes it (`mcp.probe`); the trust card and its approval come next.
 */
export function McpAddForm({
  commandsAllowed,
  checking,
  onCheck,
  onCancel,
  onSandboxReady,
}: {
  commandsAllowed: boolean;
  checking: boolean;
  onCheck: McpState["check"];
  onCancel: () => void;
  /** After the guided sandbox setup: reload what the Gateway allows. */
  onSandboxReady?: (() => void) | undefined;
}): ReactElement {
  const id = useId();
  const [d, setD] = useState<McpDraft>({
    ...EMPTY_DRAFT,
    kind: commandsAllowed ? "command" : "url",
  });
  const [pasting, setPasting] = useState(false);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  /** Servers found in the pasted JSON, when it holds more than one. */
  const [choices, setChoices] = useState<readonly ImportedServer[]>([]);
  /** The pasted server the form was filled from; its keys go to the vault on Check. */
  const [imported, setImported] = useState<ImportedServer | null>(null);
  const fill = (s: ImportedServer) => {
    setImported(s);
    setChoices([]);
    setPasting(false);
    setJson("");
    setD({
      ...s.draft,
      kind: s.draft.kind === "command" && !commandsAllowed ? "url" : s.draft.kind,
    });
  };
  const readJson = (result: ImportResult) => {
    if (!result.ok) {
      setJsonError(t(`settings.mcp.json.${result.reason}`));
      return;
    }
    setJsonError(null);
    if (result.servers.length === 1 && result.servers[0]) fill(result.servers[0]);
    else setChoices(result.servers);
  };
  const ready =
    d.name.trim() !== "" &&
    (d.kind === "url" ? /^https:\/\/\S+$/.test(d.url.trim()) : splitCommand(d.command).length > 0);
  const importedNote = imported
    ? [
        imported.secrets.length > 0
          ? t("settings.mcp.json.secrets", {
              n: imported.secrets.length,
              names: imported.secrets.map((x) => x.name).join(", "),
            })
          : null,
        imported.ignored.length > 0
          ? t("settings.mcp.json.ignored", { names: imported.ignored.join(", ") })
          : null,
      ].filter((x) => x !== null)
    : [];
  return (
    <>
      <p className="text-sm text-muted-foreground">{t("settings.mcp.addHint")}</p>
      <div className="flex flex-col gap-2">
        {pasting ? (
          <>
            <Label htmlFor={`${id}-json`}>{t("settings.mcp.json.label")}</Label>
            <Textarea
              id={`${id}-json`}
              className="font-mono"
              rows={6}
              spellCheck={false}
              autoComplete="off"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              aria-describedby={`${id}-json-hint`}
            />
            <p id={`${id}-json-hint`} className="text-xs text-muted-foreground">
              {t("settings.mcp.json.hint")}
            </p>
            {jsonError !== null ? (
              <p role="alert" className="text-sm text-danger-text">
                {jsonError}
              </p>
            ) : null}
            {choices.length > 0 ? (
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="sr-only">{t("settings.mcp.json.choose")}</legend>
                <span aria-hidden="true" className="text-sm text-muted-foreground">
                  {t("settings.mcp.json.choose")}
                </span>
                {choices.map((c) => (
                  <Button
                    key={c.name}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fill(c)}
                  >
                    {c.name}
                  </Button>
                ))}
              </fieldset>
            ) : (
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => readJson(parseMcpJson(json))}>
                  {t("settings.mcp.json.fill")}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPasting(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPasting(true)}>
              {t("settings.mcp.json.toggle")}
            </Button>
          </div>
        )}
        {importedNote.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
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
      {!commandsAllowed && onSandboxReady ? (
        <SandboxNotice message={t("settings.mcp.sandboxHelp")} onReady={onSandboxReady} />
      ) : null}
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
          onClick={() => {
            const input = toServerInput(d);
            // Keys from pasted JSON go to the vault, and the config gets placeholders.
            if (imported && imported.draft.kind === d.kind) {
              const r = withImported(input, imported, Math.random().toString(36).slice(2, 6));
              onCheck(r.input, r.secrets);
            } else {
              onCheck(input);
            }
          }}
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
