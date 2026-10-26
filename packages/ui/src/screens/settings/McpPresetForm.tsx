import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { SafeLink } from "../../links/SafeLink.tsx";
import { type McpPreset, missingFields, presetServer, presetText } from "./mcp-preset-build.ts";
import type { McpState } from "./use-mcp.tsx";

/**
 * A preset's connect form (Add connector → a ready-made MCP server): the few values it needs, with
 * where to get each key, and the example the owner can try once it is added. Keys go to the vault
 * when the server is checked, never into its config; "Check server" then runs the usual probe,
 * trust card and approval.
 */
export function McpPresetForm({
  preset,
  mcp,
  onCancel,
  onTry,
}: {
  preset: McpPreset;
  mcp: McpState;
  onCancel: () => void;
  onTry?: ((text: string) => void) | undefined;
}): ReactElement {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const commandless = preset.transport.kind === "stdio" && mcp.launcher === "none";
  const ready = missingFields(preset, values).length === 0 && !commandless;
  const example = presetText(preset, "example");
  return (
    <>
      <p className="text-sm text-muted-foreground">{presetText(preset, "desc")}</p>
      {preset.fields.map((f) => (
        <div key={f.id} className="flex flex-col gap-1">
          <Label htmlFor={`${id}-${f.id}`}>{presetText(preset, `field.${f.id}.label`)}</Label>
          <Input
            id={`${id}-${f.id}`}
            type={f.kind === "secret" ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            className={f.kind === "secret" ? "font-mono" : undefined}
            {...(f.placeholder ? { placeholder: f.placeholder } : {})}
            value={values[f.id] ?? ""}
            onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
            aria-describedby={`${id}-${f.id}-help`}
          />
          <p id={`${id}-${f.id}-help`} className="text-xs text-muted-foreground">
            {presetText(preset, `field.${f.id}.help`)}
            {f.helpUrl ? (
              <>
                {" "}
                <SafeLink href={f.helpUrl} className="underline underline-offset-2">
                  {t("gallery.getKey")}
                </SafeLink>
              </>
            ) : null}
            {f.kind === "secret" ? ` ${t("gallery.keyStaysInVault")}` : ""}
          </p>
        </div>
      ))}
      {commandless ? (
        <p className="text-sm text-muted-foreground">{t("settings.mcp.kind.commandUnavailable")}</p>
      ) : null}
      <div className="flex flex-col gap-1 rounded-md bg-fill-quaternary px-3 py-2 text-callout">
        <span className="text-label-secondary">{t("gallery.tryAsking")}</span>
        <span className="flex flex-wrap items-center gap-2">
          <q className="flex-1 text-label-primary">{example}</q>
          {onTry ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onTry(example)}>
              {t("settings.connectors.try.title")}
            </Button>
          ) : null}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!ready || mcp.checking}
          onClick={() => {
            const nonce = Math.random().toString(36).slice(2, 6);
            const { input, secrets } = presetServer(preset, values, nonce);
            mcp.check(input, secrets);
          }}
        >
          {mcp.checking ? t("settings.mcp.checking") : t("settings.mcp.check")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </>
  );
}
