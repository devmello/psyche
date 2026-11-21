import { AlertTriangle } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { ErrorNotice, Group, messageOf } from "./shared.tsx";

/**
 * Settings → Browser "Import sign-ins from another browser" (desktop only; docs/design/
 * cookie-import-2026.md). The owner picks a browser and a profile, reads its sign-ins, ticks
 * sites and imports them into Psyche's browser. Nothing is ticked at first, and "Select all"
 * leaves out banks, payments, password managers and email. The window only ever sees domains,
 * counts and flags; cookie values stay in the desktop's main process.
 */

export type CookieImportBrowser = "chrome" | "brave" | "edge" | "arc" | "firefox" | "safari";
export type CookieImportSensitive = "bank" | "payment" | "passwords" | "email" | "signin";

export interface CookieImportSource {
  browser: CookieImportBrowser;
  supported: boolean;
  reason?: "full_disk_access" | "platform";
  installed: boolean;
  profiles: { id: string; name: string }[];
}

export interface CookieImportSite {
  domain: string;
  hosts: string[];
  cookies: number;
  sensitive: CookieImportSensitive | null;
}

export interface CookieImportScan {
  scanId: string;
  browser: CookieImportBrowser;
  sites: CookieImportSite[];
  expired: number;
  skipped: number;
}

export interface CookieImportResult {
  sites: { domain: string; cookies: number }[];
  failed: number;
}

export interface ImportedSignIn {
  domain: string;
  browser: CookieImportBrowser;
  cookies: number;
  importedAt: string;
}

export interface CookieImportApi {
  sources(): Promise<CookieImportSource[]>;
  scan(browser: CookieImportBrowser, profileId: string): Promise<CookieImportScan>;
  /**
   * `sensitive` names the picked sensitive sites, ticked one by one: the desktop refuses a
   * sensitive site that isn't named.
   */
  import(scanId: string, domains: string[], sensitive?: string[]): Promise<CookieImportResult>;
  discard(scanId: string): Promise<void>;
  imported(): Promise<ImportedSignIn[]>;
  /** Deletes the cookies the import wrote for one site. */
  remove(domain: string): Promise<void>;
}

// i18n-ignore-start: browser product names
const BROWSER_NAMES: Record<CookieImportBrowser, string> = {
  chrome: "Google Chrome",
  brave: "Brave",
  edge: "Microsoft Edge",
  arc: "Arc",
  firefox: "Firefox",
  safari: "Safari",
};
// i18n-ignore-end

export function browserName(b: CookieImportBrowser): string {
  return BROWSER_NAMES[b];
}

const HOSTS_SHOWN = 4;

/** The hosts inside a row, so a merged-looking row is never a mystery. */
export function hostsLine(hosts: readonly string[]): string {
  const shown = hosts.slice(0, HOSTS_SHOWN).join(", ");
  return hosts.length > HOSTS_SHOWN
    ? t("settings.browser.import.hostsMore", { hosts: shown, count: hosts.length - HOSTS_SHOWN })
    : t("settings.browser.import.hosts", { hosts: shown });
}

function sensitiveLabel(kind: CookieImportSensitive): string {
  switch (kind) {
    case "bank":
      return t("settings.browser.import.sensitive.bank");
    case "payment":
      return t("settings.browser.import.sensitive.payment");
    case "passwords":
      return t("settings.browser.import.sensitive.passwords");
    case "email":
      return t("settings.browser.import.sensitive.email");
    case "signin":
      return t("settings.browser.import.sensitive.signin");
  }
}

/** Sites "Select all" ticks: every listed one except the sensitive ones. */
export function selectAllExceptSensitive(sites: readonly CookieImportSite[]): Set<string> {
  return new Set(sites.filter((s) => s.sensitive === null).map((s) => s.domain));
}

export function filterSites(sites: readonly CookieImportSite[], query: string): CookieImportSite[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...sites];
  return sites.filter((s) => s.domain.includes(q) || s.hosts.some((h) => h.includes(q)));
}

export function CookieImportGroup({ api }: { api: CookieImportApi }): ReactElement {
  const id = useId();
  const [sources, setSources] = useState<CookieImportSource[] | null>(null);
  const [browser, setBrowser] = useState<CookieImportBrowser | "">("");
  const [profileId, setProfileId] = useState("");
  const [scan, setScan] = useState<CookieImportScan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportedSignIn[]>([]);

  const reloadImported = useCallback(
    () =>
      api.imported().then(setImported, () => {
        // The list is a convenience; the import still works without it.
      }),
    [api],
  );
  useEffect(() => {
    let live = true;
    api.sources().then(
      (s) => live && setSources(s),
      (err: unknown) =>
        live && setError(t("settings.browser.import.sourcesFailed", { reason: messageOf(err) })),
    );
    void reloadImported();
    return () => {
      live = false;
    };
  }, [api, reloadImported]);

  const source = sources?.find((s) => s.browser === browser);
  const readable = (sources ?? []).filter((s) => s.supported && s.installed);
  const unsupported = (sources ?? []).filter((s) => !s.supported);
  const shown = useMemo(() => (scan ? filterSites(scan.sites, query) : []), [scan, query]);

  const choose = (b: CookieImportBrowser | "") => {
    setBrowser(b);
    const next = sources?.find((s) => s.browser === b);
    setProfileId(next?.profiles[0]?.id ?? "");
  };
  const cancel = () => {
    if (scan) void api.discard(scan.scanId).catch(() => undefined);
    setScan(null);
    setPicked(new Set());
    setQuery("");
  };
  const read = () => {
    if (browser === "" || profileId === "") return;
    setError(null);
    setNotice(null);
    setBusy(true);
    api
      .scan(browser, profileId)
      .then(
        (s) => {
          setScan(s);
          setPicked(new Set());
        },
        (err: unknown) =>
          setError(
            t("settings.browser.import.readFailed", {
              browser: browserName(browser),
              reason: messageOf(err),
            }),
          ),
      )
      .finally(() => setBusy(false));
  };
  const doImport = () => {
    if (!scan || picked.size === 0) return;
    setError(null);
    setBusy(true);
    api
      .import(
        scan.scanId,
        [...picked].sort(),
        scan.sites
          .filter((s) => s.sensitive !== null && picked.has(s.domain))
          .map((s) => s.domain)
          .sort(),
      )
      .then(
        (r) => {
          setScan(null);
          setPicked(new Set());
          setQuery("");
          setNotice(
            [
              t("settings.browser.import.done", { count: r.sites.length }),
              ...(r.failed > 0 ? [t("settings.browser.import.refused", { count: r.failed })] : []),
            ].join(" "),
          );
          void reloadImported();
        },
        (err: unknown) =>
          setError(t("settings.browser.import.importFailed", { reason: messageOf(err) })),
      )
      .finally(() => setBusy(false));
  };
  const toggle = (domain: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(domain);
      else next.delete(domain);
      return next;
    });

  return (
    <Group
      title={t("settings.browser.import.title")}
      description={t("settings.browser.import.description")}
    >
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-gray-3 px-3 py-2"
          data-testid="cookie-import-done"
        >
          {notice}
        </p>
      ) : null}
      {scan === null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-browser`}>{t("settings.browser.import.from")}</Label>
              <NativeSelect
                id={`${id}-browser`}
                value={browser}
                disabled={busy}
                onChange={(e) => choose(e.target.value as CookieImportBrowser | "")}
              >
                <option value="">{t("settings.browser.import.chooseBrowser")}</option>
                {readable.map((s) => (
                  <option key={s.browser} value={s.browser}>
                    {browserName(s.browser)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {source && source.profiles.length > 1 ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-profile`}>{t("settings.browser.import.profile")}</Label>
                <NativeSelect
                  id={`${id}-profile`}
                  value={profileId}
                  disabled={busy}
                  onChange={(e) => setProfileId(e.target.value)}
                >
                  {source.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || browser === "" || profileId === ""}
              onClick={read}
            >
              {busy ? t("settings.browser.import.reading") : t("settings.browser.import.read")}
            </Button>
          </div>
          {source && source.profiles.length === 0 ? (
            <p className="text-callout text-muted-foreground">
              {t("settings.browser.import.noProfiles", { browser: browserName(source.browser) })}
            </p>
          ) : null}
          {browser !== "" && browser !== "firefox" ? (
            <p className="text-callout text-muted-foreground">
              {t("settings.browser.import.keychainHint", { browser: browserName(browser) })}
            </p>
          ) : null}
          {sources !== null && readable.length === 0 && unsupported.length < sources.length ? (
            <p className="text-callout text-muted-foreground">
              {t("settings.browser.import.noneInstalled")}
            </p>
          ) : null}
          {unsupported.map((s) => (
            <p
              key={s.browser}
              className="text-callout text-muted-foreground"
              data-testid={`cookie-import-unsupported-${s.browser}`}
            >
              {s.reason === "full_disk_access"
                ? t("settings.browser.import.unsupportedFda", { browser: browserName(s.browser) })
                : t("settings.browser.import.unsupportedPlatform", {
                    browser: browserName(s.browser),
                  })}
            </p>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="cookie-import-pick">
          {scan.expired + scan.skipped > 0 ? (
            <p className="text-callout text-muted-foreground">
              {t("settings.browser.import.leftOut", {
                expired: scan.expired,
                skipped: scan.skipped,
              })}
            </p>
          ) : null}
          {scan.sites.length === 0 ? (
            <p className="text-muted-foreground">{t("settings.browser.import.noneFound")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="search"
                  className="max-w-64"
                  aria-label={t("settings.browser.import.search")}
                  placeholder={t("settings.browser.import.search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPicked(selectAllExceptSensitive(scan.sites))}
                >
                  {t("settings.browser.import.selectAll")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPicked(new Set())}
                >
                  {t("settings.browser.import.clear")}
                </Button>
              </div>
              {shown.length === 0 ? (
                <p className="text-muted-foreground">
                  {t("settings.browser.import.noMatch", { query })}
                </p>
              ) : null}
              <ul
                className="flex max-h-80 flex-col gap-1.5 overflow-y-auto"
                data-testid="cookie-import-sites"
              >
                {shown.map((s) => (
                  <li key={s.domain} className="flex items-start gap-2">
                    <Checkbox
                      id={`${id}-site-${s.domain}`}
                      className="mt-0.5"
                      checked={picked.has(s.domain)}
                      onCheckedChange={(v) => toggle(s.domain, v === true)}
                    />
                    <Label htmlFor={`${id}-site-${s.domain}`} className="flex flex-col font-normal">
                      <span>
                        <span className="font-mono">{s.domain}</span>{" "}
                        <span className="text-callout text-muted-foreground">
                          {t("settings.browser.import.cookies", { count: s.cookies })}
                        </span>
                      </span>
                      <span
                        className="text-callout text-muted-foreground"
                        data-testid={`cookie-import-hosts-${s.domain}`}
                      >
                        {hostsLine(s.hosts)}
                      </span>
                      {s.sensitive ? (
                        <span
                          className="flex items-center gap-1 text-callout text-approval"
                          data-testid={`cookie-import-sensitive-${s.domain}`}
                        >
                          <AlertTriangle aria-hidden="true" className="size-3.5" />
                          {t("settings.browser.import.sensitiveWarning", {
                            kind: sensitiveLabel(s.sensitive),
                          })}
                        </span>
                      ) : null}
                    </Label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-callout text-muted-foreground">
            {t("settings.browser.import.noTrust")}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || picked.size === 0} onClick={doImport}>
              {t("settings.browser.import.importN", { count: picked.size })}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>
              {t("settings.browser.import.cancel")}
            </Button>
          </div>
        </div>
      )}
      {imported.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-headline">{t("settings.browser.import.importedTitle")}</h4>
          <p className="text-callout text-muted-foreground">
            {t("settings.browser.import.removeHint")}
          </p>
          <ul className="flex flex-col gap-2" data-testid="cookie-import-imported">
            {imported.map((s) => (
              <li key={s.domain} className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-mono">{s.domain}</span>
                  <span className="block text-callout text-muted-foreground">
                    {t("settings.browser.import.importedFrom", {
                      browser: browserName(s.browser),
                      date: s.importedAt.slice(0, 10),
                      count: s.cookies,
                    })}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    api.remove(s.domain).then(reloadImported, (err: unknown) =>
                      setError(
                        t("settings.browser.import.removeFailed", {
                          site: s.domain,
                          reason: messageOf(err),
                        }),
                      ),
                    );
                  }}
                >
                  {t("settings.browser.import.remove")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Group>
  );
}
