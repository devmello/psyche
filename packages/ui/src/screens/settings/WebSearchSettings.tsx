import { type ReactElement, useEffect, useId, useState } from "react";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { Facts, Group, SettingHint, type SettingsValues } from "./shared.tsx";

/**
 * Web search for the agent's built-in `web.search` / `web.fetch` tools (#557), under Model &
 * providers: which provider to use, the SearXNG URL, and what is in effect. The Gateway writes
 * the read-only `search.web.status` setting; the Brave key comes from `PSYCHE_SEARCH_BRAVE_KEY`
 * and never reaches the client.
 */

export const WEB_SEARCH_KEYS = {
  provider: "search.web.provider",
  searxngUrl: "search.web.searxngUrl",
  status: "search.web.status",
} as const;

const PREFERENCES = ["auto", "brave", "searxng", "duckduckgo", "off"] as const;
type Preference = (typeof PREFERENCES)[number];
const ACTIVE = ["brave", "searxng", "duckduckgo", "off"] as const;
type Active = (typeof ACTIVE)[number];

interface WebSearchStatus {
  preference: Preference;
  active: Active;
  brave: "env" | "vault" | null;
  searxngUrl: string | null;
  note: string | null;
}

function statusOf(v: unknown): WebSearchStatus | null {
  if (typeof v !== "object" || v === null || !("active" in v)) return null;
  const s = v as Partial<WebSearchStatus>;
  return ACTIVE.includes(s.active as Active) ? (s as WebSearchStatus) : null;
}

function preferenceOf(v: unknown): Preference {
  return PREFERENCES.includes(v as Preference) ? (v as Preference) : "auto";
}

/** An http(s) URL without credentials, or `null` (blank clears the setting). */
export function checkSearxngUrl(raw: string): { ok: true; value: string | null } | { ok: false } {
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  try {
    const u = new URL(v);
    if (
      (u.protocol !== "http:" && u.protocol !== "https:") ||
      u.username !== "" ||
      u.password !== ""
    )
      return { ok: false };
    return { ok: true, value: u.toString() };
  } catch {
    return { ok: false };
  }
}

export function WebSearchSettingsGroup({
  values,
  onChange,
}: {
  values: SettingsValues;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const selectId = useId();
  const urlId = useId();
  const status = statusOf(values[WEB_SEARCH_KEYS.status]);
  const preference = preferenceOf(values[WEB_SEARCH_KEYS.provider]);
  const saved =
    typeof values[WEB_SEARCH_KEYS.searxngUrl] === "string"
      ? (values[WEB_SEARCH_KEYS.searxngUrl] as string)
      : "";
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState(false);
  useEffect(() => setDraft(saved), [saved]);

  const commitUrl = () => {
    const r = checkSearxngUrl(draft);
    if (!r.ok) {
      setError(true);
      return;
    }
    setError(false);
    if ((r.value ?? "") !== saved) onChange(WEB_SEARCH_KEYS.searxngUrl, r.value ?? "");
  };

  return (
    <Group title={t("settings.webSearch.title")} description={t("settings.webSearch.description")}>
      <Facts
        items={[
          {
            term: t("settings.webSearch.inUse"),
            value:
              status === null
                ? t("settings.webSearch.unknown")
                : t(`settings.webSearch.provider.${status.active}`),
          },
          {
            term: t("settings.webSearch.braveKey"),
            value:
              status?.brave === "env"
                ? t("settings.webSearch.braveFromEnv")
                : t("settings.webSearch.braveNone"),
          },
        ]}
      />
      {status?.note ? <p className="text-xs text-muted-foreground">{status.note}</p> : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className="font-medium text-foreground">
          {t("settings.key.search.web.provider")}
        </label>
        <NativeSelect
          id={selectId}
          value={preference}
          onChange={(e) => onChange(WEB_SEARCH_KEYS.provider, e.target.value)}
        >
          {PREFERENCES.map((p) => (
            <option key={p} value={p}>
              {t(`settings.webSearch.choice.${p}`)}
            </option>
          ))}
        </NativeSelect>
        <SettingHint settingKey={WEB_SEARCH_KEYS.provider} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className="font-medium text-foreground">
          {t("settings.key.search.web.searxngUrl")}
        </label>
        <p id={`${urlId}-desc`} className="text-xs text-muted-foreground">
          {t("settings.webSearch.searxngHint")}
        </p>
        <Input
          id={urlId}
          type="url"
          inputMode="url"
          placeholder="http://127.0.0.1:8888"
          value={draft}
          aria-describedby={`${urlId}-desc${error ? ` ${urlId}-error` : ""}`}
          aria-invalid={error}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitUrl();
          }}
        />
        {error ? (
          <p id={`${urlId}-error`} role="alert" className="text-xs text-destructive">
            {t("settings.webSearch.searxngInvalid")}
          </p>
        ) : null}
        <SettingHint settingKey={WEB_SEARCH_KEYS.searxngUrl} />
      </div>
    </Group>
  );
}
