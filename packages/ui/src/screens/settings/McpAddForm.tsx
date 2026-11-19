import type { McpServerChanges, McpServerConfigView } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { McpEnvRows } from "./McpEnvRows.tsx";
import {
  draftOf,
  EMPTY_DRAFT,
  editChanges,
  envNamesValid,
  isSecretEnvName,
  type McpDraft,
  splitCommand,
  toServerInput,
} from "./mcp-input.ts";
import {
  type ImportedServer,
  type ImportResult,
  parseMcpJson,
  withEnvRows,
  withImported,
} from "./mcp-json.ts";
import { SandboxNotice } from "./SandboxNotice.tsx";
import { RadioField } from "./shared.tsx";
import type { McpSecret, McpState } from "./use-mcp.tsx";

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
  edit,
}: {
  commandsAllowed: boolean;
  checking: boolean;
  onCheck: McpState["check"];
  onCancel: () => void;
  /** After the guided sandbox setup: reload what the Gateway allows. */
  onSandboxReady?: (() => void) | undefined;
  /**
   * Editing a server already added: the form opens prefilled (secrets show "Saved", never a
   * value) and Save runs the update flow instead of Check server.
   */
  edit?:
    | {
        config: McpServerConfigView;
        onSave: (changes: McpServerChanges, secrets: McpSecret[]) => void;
      }
    | undefined;
}): ReactElement {
  const id = useId();
  const [d, setD] = useState<McpDraft>(
    edit
      ? draftOf(edit.config)
      : {
          ...EMPTY_DRAFT,
          kind: commandsAllowed ? "command" : "url",
        },
  );
  const [pasting, setPasting] = useState(false);
  /** Editing a URL server: the address stays hidden and untouched until the owner replaces it. */
  const [changingUrl, setChangingUrl] = useState(false);
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
      env: d.env ?? [],
      kind: s.draft.kind === "command" && !commandsAllowed ? "url" : s.draft.kind,
    });
  };
  /** Pasted keys and typed env values both go to the vault before the probe, never into config. */
  const submit = () => {
    const nonce = Math.random().toString(36).slice(2, 6);
    if (edit) {
      const r = editChanges(edit.config, d, nonce);
      if (r.secrets.length > 0) {
        // The values are stored: clear them from the form, so nothing reads back.
        setD((prev) => ({
          ...prev,
          env: (prev.env ?? []).map((row) =>
            isSecretEnvName(row.name.trim()) && row.value !== ""
              ? { ...row, value: "", saved: true }
              : row,
          ),
        }));
      }
      edit.onSave(r.changes, r.secrets);
      return;
    }
    let input = toServerInput(d);
    let secrets: McpSecret[] = [];
    if (imported && imported.draft.kind === d.kind) {
      const r = withImported(input, imported, nonce);
      input = r.input;
      secrets = [...r.secrets];
    }
    const typed = withEnvRows(input, d.env, nonce);
    input = typed.input;
    secrets = [...secrets, ...typed.secrets];
    if (typed.secrets.length > 0) {
      // The values are stored: clear them from the form, so nothing reads back.
      setD((prev) => ({
        ...prev,
        env: (prev.env ?? []).map((r) =>
          isSecretEnvName(r.name.trim()) && r.value !== "" ? { ...r, value: "", saved: true } : r,
        ),
      }));
    }
    onCheck(input, secrets);
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
  const dirty = edit ? Object.keys(editChanges(edit.config, d, "x").changes).length > 0 : true;
  const ready =
    dirty &&
    d.name.trim() !== "" &&
    (d.kind === "url"
      ? /^https:\/\/\S+$/.test(d.url.trim())
      : splitCommand(d.command).length > 0 && envNamesValid(d.env));
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
      <p className="text-sm text-muted-foreground">
        {edit ? t("settings.mcp.edit.intro") : t("settings.mcp.addHint")}
      </p>
      <div className="flex flex-col gap-2">
        {edit ? null : pasting ? (
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
            <p id={`${id}-json-hint`} className="text-callout text-muted-foreground">
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
          <p key={line} className="text-callout text-muted-foreground">
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
      {edit ? null : (
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
      )}
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
          <McpEnvRows
            id={id}
            rows={d.env ?? []}
            onChange={(env) => setD({ ...d, env: [...env] })}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-domains`}>{t("settings.mcp.domains")}</Label>
            <Input
              id={`${id}-domains`}
              placeholder={t("settings.mcp.placeholder.domains")}
              value={d.domains}
              onChange={(e) => setD({ ...d, domains: e.target.value })}
              aria-describedby={`${id}-domains-hint`}
            />
            <p id={`${id}-domains-hint`} className="text-callout text-muted-foreground">
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
            readOnly={edit !== undefined && !changingUrl}
            onChange={(e) => setD({ ...d, url: e.target.value })}
          />
          {edit !== undefined && !changingUrl ? (
            <div className="flex flex-col items-start gap-1">
              <p className="text-callout text-muted-foreground">
                {t("settings.mcp.edit.urlHidden")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setChangingUrl(true);
                  setD({ ...d, url: "" });
                }}
              >
                {t("settings.mcp.edit.changeUrl")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!ready || checking || (d.kind === "command" && !commandsAllowed)}
          onClick={submit}
        >
          {checking
            ? t("settings.mcp.checking")
            : edit
              ? t("settings.mcp.edit.save")
              : t("settings.mcp.check")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </>
  );
}
