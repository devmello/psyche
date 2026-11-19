import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import { type EnvRow, envNamesValid, isSecretEnvName } from "./mcp-input.ts";

/**
 * Environment variables for a command server, typed into the Add form. A name that says it holds
 * a secret (token, key, password…) gets a password field; its value goes to the vault when the
 * server is checked, and the field then shows "Saved" with nothing to read back.
 */
export function McpEnvRows({
  id,
  rows,
  onChange,
}: {
  id: string;
  rows: readonly EnvRow[];
  onChange: (rows: readonly EnvRow[]) => void;
}): ReactElement {
  const update = (key: string, patch: Partial<EnvRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const badName = !envNamesValid(rows);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-label-primary">
        {t("settings.mcp.env.title")}
      </legend>
      <p className="text-callout text-muted-foreground">{t("settings.mcp.env.hint")}</p>
      {rows.map((r) => {
        const secret = isSecretEnvName(r.name.trim());
        return (
          <div key={r.key} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t("settings.mcp.env.name")}
              className="min-w-0 flex-1 font-mono"
              placeholder={t("settings.mcp.env.namePlaceholder")}
              value={r.name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => update(r.key, { name: e.target.value })}
            />
            <Input
              aria-label={t("settings.mcp.env.value")}
              className="min-w-0 flex-1 font-mono"
              type={secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={r.saved ? t("settings.mcp.env.saved") : undefined}
              value={r.value}
              maxLength={4000}
              onChange={(e) => update(r.key, { value: e.target.value, saved: false })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
            >
              {t("common.remove")}
            </Button>
          </div>
        );
      })}
      {badName ? (
        <p role="alert" className="text-sm text-danger-text">
          {t("settings.mcp.env.badName")}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([...rows, { key: `${id}-${rows.length}-${Date.now()}`, name: "", value: "" }])
          }
        >
          {t("settings.mcp.env.add")}
        </Button>
      </div>
    </fieldset>
  );
}
