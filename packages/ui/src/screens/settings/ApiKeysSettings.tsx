import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { Group } from "./shared.tsx";

/**
 * Settings → Model & providers → API keys (setup without a terminal): one row per hosted model
 * provider and one for web search. The field is write-only: a saved key is never read back, so
 * the row shows only whether one is set and where it comes from. The draft is dropped as soon as
 * it is sent. No call is made to the provider to test the key.
 */

export const API_KEY_IDS = ["anthropic", "openai", "google", "openrouter", "brave"] as const;
export type ApiKeyId = (typeof API_KEY_IDS)[number];

export interface ApiKeyStatus {
  id: ApiKeyId;
  configured: boolean;
  source: "env" | "vault" | null;
  inVault: boolean;
}

/** Light local check before anything is sent: not empty, no whitespace. */
export function checkApiKeyDraft(raw: string): "empty" | "whitespace" | null {
  const v = raw.trim();
  if (v === "") return "empty";
  return /\s/.test(v) ? "whitespace" : null;
}

const messageOf = (err: unknown): string =>
  err instanceof Error && err.message !== "" ? err.message : String(err);

function statusLine(s: ApiKeyStatus): string {
  if (s.source === "env") {
    return s.inVault ? t("settings.apiKeys.envAndVault") : t("settings.apiKeys.env");
  }
  return s.source === "vault" ? t("settings.apiKeys.vault") : t("settings.apiKeys.none");
}

function KeyRow({
  status,
  onChanged,
}: {
  status: ApiKeyStatus;
  onChanged: () => void;
}): ReactElement {
  const call = useCall();
  const id = useId();
  const name = t(`settings.apiKeys.name.${status.id}`);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const problem = checkApiKeyDraft(draft);
    if (problem !== null) {
      setError(t(problem === "empty" ? "settings.apiKeys.empty" : "settings.apiKeys.whitespace"));
      return;
    }
    const key = draft.trim();
    setBusy(true);
    setError(null);
    try {
      await call("keys.set", { id: status.id, key });
      // The draft is dropped once the Gateway has it; a failed save keeps it to try again.
      setDraft("");
      onChanged();
    } catch (err) {
      const reason = messageOf(err);
      setError(
        /vault is locked/i.test(reason)
          ? t("settings.apiKeys.locked")
          : t("settings.apiKeys.failed", { reason }),
      );
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("keys.clear", { id: status.id });
      onChanged();
    } catch (err) {
      setError(t("settings.apiKeys.clearFailed", { reason: messageOf(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={`api-key-${status.id}`}>
      <label htmlFor={`${id}-key`} className="font-medium text-foreground">
        {t("settings.apiKeys.field", { name })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`${id}-key`}
          type="password"
          // Not a login: password managers must not offer to fill or save it.
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          spellCheck={false}
          aria-describedby={`${id}-status`}
          className="h-8 min-w-72 rounded-md border border-input bg-transparent px-2 text-sm"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          disabled={busy}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || draft.trim() === ""}
          onClick={() => void save()}
        >
          {busy ? t("settings.apiKeys.saving") : t("settings.apiKeys.save")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || !status.inVault}
          onClick={() => void clear()}
        >
          {t("settings.apiKeys.clear")}
        </Button>
      </div>
      <p id={`${id}-status`} className="text-callout text-muted-foreground">
        {statusLine(status)}
      </p>
      {error !== null ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ApiKeysGroup({
  keys,
  onChanged,
}: {
  keys: readonly ApiKeyStatus[];
  onChanged: () => void;
}): ReactElement {
  return (
    <Group title={t("settings.apiKeys.title")} description={t("settings.apiKeys.description")}>
      {API_KEY_IDS.map((id) => {
        const status = keys.find((k) => k.id === id) ?? {
          id,
          configured: false,
          source: null,
          inVault: false,
        };
        return <KeyRow key={id} status={status} onChanged={onChanged} />;
      })}
    </Group>
  );
}
