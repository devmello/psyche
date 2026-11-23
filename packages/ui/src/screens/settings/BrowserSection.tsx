import type { BotAuthStatus, BrowserAgentSettings } from "@psyche/protocol";
import {
  BROWSER_DEV_PREVIEW_PORTS_ENV,
  BROWSER_DEV_PREVIEW_PORTS_KEY,
  BROWSER_PARTITION_ENV,
  BROWSER_PARTITION_KEY,
  BROWSER_SIGNED_IN_ORIGINS_ENV,
  BROWSER_SIGNED_IN_ORIGINS_KEY,
  type BrowserPartitionMode,
  DEFAULT_BROWSER_PARTITION,
  normalizeBrowserOrigin,
  normalizeDevPreviewPort,
  type OriginRefusal,
  parseBrowserPartition,
} from "@psyche/protocol/browser-agent";
import { ExternalLink, KeyRound } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { LINK_OPEN_SETTING, type LinkOpenMode, linkOpenMode } from "../../links/link-policy.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { type CookieImportApi, CookieImportGroup } from "./CookieImportGroup.tsx";
import {
  Advanced,
  ErrorNotice,
  Facts,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
  TextSetting,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Browser (feature I13; UI design §3.5, §3.18): real-Chrome mode and the Psyche Chrome profile.
 * The switch is the admin setting `browser.realChrome` (`{ enabled, profile? }`); the Gateway
 * reads it on every use. Each task still asks for consent, a device-only `policy_change` card
 * with presence, whatever the switch says (security §6).
 */

export const REAL_CHROME_KEY = "browser.realChrome";

/** The real-Chrome profile's name: "Psyche profile", with the persona's name when one is set. */
export function realChromeProfileLabel(persona: string | undefined): string {
  return persona ? t("settings.browser.profileNamed", { persona }) : t("settings.browser.profile");
}

export interface RealChromeSetting {
  enabled: boolean;
  profile?: string;
}

export function realChromeOf(values: Readonly<Record<string, unknown>>): RealChromeSetting {
  const raw = values[REAL_CHROME_KEY];
  if (typeof raw !== "object" || raw === null) return { enabled: false };
  const v = raw as { enabled?: unknown; profile?: unknown };
  return {
    enabled: v.enabled === true,
    ...(typeof v.profile === "string" && v.profile !== "" ? { profile: v.profile } : {}),
  };
}

/**
 * Web Bot Auth (I14; security §6): the admin setting `browser.botAuth {enabled, signatureAgent?,
 * origins?}`. With it on, a key and a directory URL, Psyche signs requests to sites that ask
 * (`Accept-Signature`) and to listed origins, never in logged-out tasks. The key lives in the
 * vault; the panel shows its fingerprint and rotates it (`browser.botAuth.rotate`).
 */
export const BOT_AUTH_KEY = "browser.botAuth";

export interface BotAuthSetting {
  enabled: boolean;
  signatureAgent?: string;
  origins?: string[];
}

export function botAuthOf(values: Readonly<Record<string, unknown>>): BotAuthSetting {
  const raw = values[BOT_AUTH_KEY];
  if (typeof raw !== "object" || raw === null) return { enabled: false };
  const v = raw as { enabled?: unknown; signatureAgent?: unknown; origins?: unknown };
  return {
    enabled: v.enabled === true,
    ...(typeof v.signatureAgent === "string" && v.signatureAgent !== ""
      ? { signatureAgent: v.signatureAgent }
      : {}),
    ...(Array.isArray(v.origins)
      ? { origins: v.origins.filter((o): o is string => typeof o === "string") }
      : {}),
  };
}

/**
 * "Let Psyche use my signed-in sessions" (admin key, boolean, default on): tasks open a site in
 * the persistent profile when it holds a session for the site's registrable domain. Off keeps
 * tasks logged out except for sites chosen with "Stay signed in".
 */
export const USE_SIGNED_IN_KEY = "browser.useSignedInSessions";

export function useSignedInOf(values: Readonly<Record<string, unknown>>): boolean {
  return values[USE_SIGNED_IN_KEY] !== false;
}

/** A site signed in to in the persistent profile (desktop only). */
export interface SignedInSite {
  origin: string;
  hosts: string[];
  addedAt: string;
  /** Found from the profile's cookies rather than chosen with "Stay signed in". */
  detected?: boolean;
}

export interface SignedInSitesApi {
  list(): Promise<SignedInSite[]>;
  /** Removes the site from the list and deletes its cookies from the profile. */
  forget(origin: string): Promise<void>;
}

/** Whether recordings the owner keeps (teach by showing) are encrypted on this Mac. */
export type TeachStorageStatus = () => Promise<{ encrypted: boolean }>;

/**
 * Settings → Browser "Recordings you keep": kept recordings are encrypted with a key held in the
 * OS keychain. When the keychain is not available none is kept, and this says so.
 */
export function TeachStorageGroup({ status }: { status: TeachStorageStatus }): ReactElement | null {
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    status().then(
      (s) => live && setEncrypted(s.encrypted),
      () => live && setEncrypted(null),
    );
    return () => {
      live = false;
    };
  }, [status]);
  if (encrypted === null) return null;
  return (
    <Group
      title={t("settings.teach.storage.title")}
      description={t("settings.teach.storage.description")}
    >
      <p className="text-callout" data-testid="teach-storage">
        {encrypted
          ? t("settings.teach.storage.encrypted")
          : t("settings.teach.storage.unavailable")}
      </p>
    </Group>
  );
}

/** Settings → Browser "Signed-in sites": what "Stay signed in" kept, each with Sign out. */
export function SignedInSitesGroup({ api }: { api: SignedInSitesApi }): ReactElement {
  const [sites, setSites] = useState<SignedInSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      api.list().then(
        (s) => setSites(s),
        (err: unknown) =>
          setError(t("settings.browser.signedIn.loadFailed", { reason: messageOf(err) })),
      ),
    [api],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <Group
      title={t("settings.browser.signedIn.title")}
      description={t("settings.browser.signedIn.description")}
    >
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      {sites !== null && sites.length === 0 ? (
        <p className="text-muted-foreground" data-testid="signed-in-empty">
          {t("settings.browser.signedIn.none")}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2" data-testid="signed-in-sites">
        {(sites ?? []).map((s) => (
          <li key={s.origin} className="flex items-center justify-between gap-3">
            <span>
              <span className="font-mono">{s.origin.replace(/^https:\/\//, "")}</span>
              {s.detected ? (
                <span
                  className="ms-2 text-callout text-muted-foreground"
                  data-testid="signed-in-auto"
                >
                  {t("settings.browser.signedIn.auto")}
                </span>
              ) : null}
              {s.hosts.length > 1 ? (
                <span className="block text-callout text-muted-foreground">
                  {t("settings.browser.signedIn.viaHosts", { hosts: s.hosts.join(", ") })}
                </span>
              ) : null}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null);
                api.forget(s.origin).then(reload, (err: unknown) =>
                  setError(
                    t("settings.browser.signedIn.forgetFailed", {
                      site: s.origin,
                      reason: messageOf(err),
                    }),
                  ),
                );
              }}
            >
              {t("settings.browser.signedIn.forget")}
            </Button>
          </li>
        ))}
      </ul>
    </Group>
  );
}

/** Why an origin was refused, in the owner's words. */
function refusalText(reason: OriginRefusal): string {
  switch (reason) {
    case "wildcard":
      return t("settings.browser.agent.refuse.wildcard");
    case "credentials":
      return t("settings.browser.agent.refuse.credentials");
    case "path":
      return t("settings.browser.agent.refuse.path");
    case "scheme":
      return t("settings.browser.agent.refuse.scheme");
    case "port":
      return t("settings.browser.agent.refuse.port");
    default:
      return t("settings.browser.agent.refuse.notUrl");
  }
}

const ENV_NAME: Record<string, string> = {
  partition: BROWSER_PARTITION_ENV,
  signedInOrigins: BROWSER_SIGNED_IN_ORIGINS_ENV,
  devPreviewPorts: BROWSER_DEV_PREVIEW_PORTS_ENV,
};

/**
 * Settings → Browser "Agent sign-ins": the sign-in mode, the sites the agent may use signed in,
 * and the loopback dev-preview ports. Each is an admin setting, so a change that widens what the
 * agent can do asks for presence (the Gateway's `needsPresence`); narrowing applies at once. When
 * an environment variable sets one (a development override), it shows read-only.
 */
export function AgentBrowserGroup({
  agent,
  values,
  onChange,
}: {
  agent: BrowserAgentSettings | null | undefined;
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const partition = agent?.partition;
  const origins = agent?.signedInOrigins;
  const ports = agent?.devPreviewPorts;
  const modeEnv = partition?.source === "env";
  const originsEnv = origins?.source === "env";
  const portsEnv = ports?.source === "env";
  const mode: BrowserPartitionMode = modeEnv
    ? partition.value
    : (parseBrowserPartition(values[BROWSER_PARTITION_KEY]) ?? DEFAULT_BROWSER_PARTITION);
  const siteList: string[] = originsEnv
    ? origins.value
    : Array.isArray(values[BROWSER_SIGNED_IN_ORIGINS_KEY])
      ? (values[BROWSER_SIGNED_IN_ORIGINS_KEY] as string[])
      : [];
  const portList: number[] = portsEnv
    ? ports.value
    : Array.isArray(values[BROWSER_DEV_PREVIEW_PORTS_KEY])
      ? (values[BROWSER_DEV_PREVIEW_PORTS_KEY] as number[])
      : [];
  const [siteDraft, setSiteDraft] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [portError, setPortError] = useState<string | null>(null);

  const addSite = (): void => {
    const r = normalizeBrowserOrigin(siteDraft);
    if (!r.ok) {
      setSiteError(refusalText(r.reason));
      return;
    }
    setSiteError(null);
    setSiteDraft("");
    if (!siteList.includes(r.origin)) {
      onChange(BROWSER_SIGNED_IN_ORIGINS_KEY, [...siteList, r.origin]);
    }
  };
  const addPort = (): void => {
    const n = portDraft.trim() === "" ? Number.NaN : Number(portDraft);
    const r = normalizeDevPreviewPort(n);
    if (!r.ok) {
      setPortError(t("settings.browser.agent.refuse.port"));
      return;
    }
    setPortError(null);
    setPortDraft("");
    if (!portList.includes(r.port)) {
      onChange(
        BROWSER_DEV_PREVIEW_PORTS_KEY,
        [...portList, r.port].sort((a, b) => a - b),
      );
    }
  };

  const modeOptions: { value: BrowserPartitionMode; label: string }[] = [
    { value: "clean", label: t("settings.browser.agent.mode.clean") },
    { value: "auto", label: t("settings.browser.agent.mode.auto") },
    { value: "profile", label: t("settings.browser.agent.mode.profile") },
  ];

  return (
    <Group
      title={t("settings.browser.agent.title")}
      description={t("settings.browser.agent.description")}
    >
      <div className="flex flex-col gap-2" data-testid="agent-browser-mode">
        {modeEnv ? (
          <p className="text-callout" data-testid="agent-browser-mode-env">
            {t("settings.browser.agent.mode.label")}: {t(`settings.browser.agent.mode.${mode}`)}
            <span className="block text-muted-foreground">
              {t("settings.browser.agent.fromEnv", { variable: ENV_NAME.partition ?? "" })}
            </span>
          </p>
        ) : (
          <RadioField<BrowserPartitionMode>
            label={t("settings.browser.agent.mode.label")}
            settingKey={BROWSER_PARTITION_KEY}
            value={mode}
            onChange={(v) => onChange(BROWSER_PARTITION_KEY, v)}
            options={modeOptions}
          />
        )}
        <p className="text-callout text-muted-foreground" data-testid="agent-browser-mode-hint">
          {t(`settings.browser.agent.mode.${mode}Hint`)}
        </p>
      </div>

      <div className="flex flex-col gap-2" data-testid="agent-browser-sites">
        <p className="font-medium">{t("settings.browser.agent.sites.title")}</p>
        <p className="text-callout text-muted-foreground">
          {t("settings.browser.agent.sites.description")}
        </p>
        {originsEnv ? (
          <p className="text-callout text-muted-foreground" data-testid="agent-browser-sites-env">
            {t("settings.browser.agent.fromEnv", { variable: ENV_NAME.signedInOrigins ?? "" })}
          </p>
        ) : null}
        {siteList.length === 0 ? (
          <p className="text-muted-foreground">{t("settings.browser.agent.sites.none")}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {siteList.map((site) => (
            <li key={site} className="flex items-center justify-between gap-3">
              <span className="font-mono">{site}</span>
              {originsEnv ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t("settings.browser.agent.sites.remove", { site })}
                  onClick={() =>
                    onChange(
                      BROWSER_SIGNED_IN_ORIGINS_KEY,
                      siteList.filter((s) => s !== site),
                    )
                  }
                >
                  {t("settings.browser.agent.sites.removeShort")}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {originsEnv ? null : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addSite();
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-md border px-2 py-1 font-mono text-callout"
              aria-label={t("settings.browser.agent.sites.label")}
              // i18n-ignore: an example URL, not text
              placeholder="https://example.com"
              value={siteDraft}
              onChange={(e) => setSiteDraft(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              {t("settings.browser.agent.sites.add")}
            </Button>
          </form>
        )}
        {siteError ? (
          <p role="alert" className="text-callout">
            {siteError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2" data-testid="agent-browser-ports">
        <p className="font-medium">{t("settings.browser.agent.ports.title")}</p>
        <p className="text-callout text-muted-foreground">
          {t("settings.browser.agent.ports.description")}
        </p>
        {portsEnv ? (
          <p className="text-callout text-muted-foreground" data-testid="agent-browser-ports-env">
            {t("settings.browser.agent.fromEnv", { variable: ENV_NAME.devPreviewPorts ?? "" })}
          </p>
        ) : null}
        {portList.length === 0 ? (
          <p className="text-muted-foreground">{t("settings.browser.agent.ports.none")}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {portList.map((port) => (
            <li key={port} className="flex items-center justify-between gap-3">
              <span className="font-mono">{`localhost:${port}`}</span>
              {portsEnv ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t("settings.browser.agent.ports.remove", { port })}
                  onClick={() =>
                    onChange(
                      BROWSER_DEV_PREVIEW_PORTS_KEY,
                      portList.filter((p) => p !== port),
                    )
                  }
                >
                  {t("settings.browser.agent.sites.removeShort")}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {portsEnv ? null : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addPort();
            }}
          >
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              className="w-28 rounded-md border px-2 py-1 font-mono text-callout"
              aria-label={t("settings.browser.agent.ports.label")}
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              {t("settings.browser.agent.ports.add")}
            </Button>
          </form>
        )}
        {portError ? (
          <p role="alert" className="text-callout">
            {portError}
          </p>
        ) : null}
      </div>
    </Group>
  );
}

export interface BrowserPanelProps extends SettingsFormProps, LoadProps {
  /** The agent browser's sign-in mode, sites and dev ports, with where each comes from. */
  agentSettings?: BrowserAgentSettings | null;
  /** Web Bot Auth status from the Gateway; null while unknown. */
  botAuth?: BotAuthStatus | null;
  /** Creates or replaces the key; resolves once the Gateway has the new one. */
  onRotateBotAuth?: () => Promise<unknown>;
  persona: string;
  /** "Psyche profile (Wren)" when a persona is set, else "Psyche profile" (docs/ui-audit.md). */
  profileLabel?: string;
  /** Desktop only: opens the profile in Google Chrome; resolves to its directory. */
  onOpenProfile?: (profile: string) => Promise<{ path: string }>;
  /** Desktop only: the sites "Stay signed in" kept, with Sign out / forget. */
  signedInSites?: SignedInSitesApi;
  /** Desktop only: import sign-ins from the owner's other browsers into the profile. */
  cookieImport?: CookieImportApi;
  /** Desktop only: whether kept recordings can be stored (they are encrypted). */
  teachStorage?: TeachStorageStatus;
}

export function BrowserPanel({
  agentSettings,
  values,
  onChange,
  needsApproval,
  persona,
  profileLabel = t("settings.browser.profile"),
  onOpenProfile,
  signedInSites,
  cookieImport,
  teachStorage,
  botAuth,
  onRotateBotAuth,
  loading,
  error,
  onRetry,
}: BrowserPanelProps): ReactElement {
  const setting = realChromeOf(values);
  const wba = botAuthOf(values);
  const useSignedIn = useSignedInOf(values);
  const [rotated, setRotated] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [rotating, setRotating] = useState(false);
  const hasKey = botAuth?.keyId !== null && botAuth?.keyId !== undefined;
  const profile = setting.profile ?? "default";
  const [opened, setOpened] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.browser.title")}
      description={t("settings.browser.description", { persona })}
    >
      <LoadGate
        label={t("settings.browser.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.links.title")} description={t("settings.links.description")}>
          <RadioField<LinkOpenMode>
            label={t("settings.key.ui.links.openIn")}
            settingKey={LINK_OPEN_SETTING}
            value={linkOpenMode(values[LINK_OPEN_SETTING])}
            onChange={(v) => onChange(LINK_OPEN_SETTING, v)}
            options={[
              { value: "ask", label: t("settings.links.openIn.ask") },
              { value: "psyche", label: t("settings.links.openIn.psyche") },
              { value: "browser", label: t("settings.links.openIn.browser") },
            ]}
          />
        </Group>
        <Group
          title={t("settings.key.browser.realChrome")}
          description={t("settings.browser.realChromeDescription")}
        >
          <SwitchField
            label={t("settings.browser.letTasksUse", { profile: profileLabel })}
            description={t("settings.browser.letTasksUseHint")}
            checked={setting.enabled}
            settingKey={REAL_CHROME_KEY}
            onChange={(enabled) => onChange(REAL_CHROME_KEY, { ...setting, enabled })}
          />
        </Group>
        <Group
          title={profileLabel[0]?.toUpperCase() + profileLabel.slice(1)}
          description={t("settings.browser.profileDescription", { persona })}
        >
          <details className="text-callout text-muted-foreground">
            <summary className="cursor-pointer">{t("settings.browser.details")}</summary>
            <p className="mt-1">{t("settings.browser.detailsText", { persona })}</p>
            <p className="mt-1">
              {t("settings.browser.profilePath.profile")}{" "}
              <code className="font-mono">{profile}</code> {t("settings.browser.profilePath.in")}{" "}
              <code className="font-mono">$PSYCHE_HOME/browser/real-chrome/{profile}</code>
            </p>
          </details>
          {onOpenProfile ? (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpened(null);
                  onOpenProfile(profile).then(
                    (r) =>
                      setOpened({
                        kind: "ok",
                        text: t("settings.browser.opened", { path: r.path }),
                      }),
                    (err: unknown) =>
                      setOpened({
                        kind: "error",
                        text: t("settings.browser.openFailed", { reason: messageOf(err) }),
                      }),
                  );
                }}
              >
                <ExternalLink aria-hidden="true" /> {t("settings.browser.openProfile")}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">{t("settings.browser.openFromMac")}</p>
          )}
          {opened ? (
            opened.kind === "error" ? (
              <ErrorNotice what={opened.text} did={t("settings.shared.nothingChanged")} />
            ) : (
              <p role="status" className="rounded-md bg-gray-3 px-3 py-2">
                {opened.text}
              </p>
            )
          ) : null}
        </Group>
        <AgentBrowserGroup agent={agentSettings} values={values} onChange={onChange} />
        <Group
          title={t("settings.browser.useSignedIn.title")}
          description={t("settings.browser.useSignedIn.description", { persona })}
        >
          <SwitchField
            label={t("settings.browser.useSignedIn.label")}
            description={t("settings.browser.useSignedIn.hint")}
            checked={useSignedIn}
            settingKey={USE_SIGNED_IN_KEY}
            onChange={(on) => onChange(USE_SIGNED_IN_KEY, on)}
          />
        </Group>
        {signedInSites ? <SignedInSitesGroup api={signedInSites} /> : null}
        {cookieImport ? <CookieImportGroup api={cookieImport} /> : null}
        {teachStorage ? <TeachStorageGroup status={teachStorage} /> : null}
        <Advanced description={t("settings.browser.advancedHint")}>
          <Group
            title={t("settings.key.browser.botAuth")}
            description={t("settings.browser.botAuthDescription", { persona })}
          >
            <SwitchField
              label={t("settings.browser.signRequests")}
              description={t("settings.browser.signRequestsHint")}
              checked={wba.enabled}
              settingKey={BOT_AUTH_KEY}
              onChange={(enabled) => onChange(BOT_AUTH_KEY, { ...wba, enabled })}
            />
            <TextSetting
              label={t("settings.browser.directoryUrl")}
              description={
                <>
                  {t("settings.browser.directoryHint.before")}{" "}
                  <code className="font-mono">
                    {botAuth?.directoryPath ?? "/.well-known/http-message-signatures-directory"}
                  </code>
                  {t("settings.browser.directoryHint.after")}
                </>
              }
              // i18n-ignore: an example URL, not text
              placeholder="https://example.com/.well-known/http-message-signatures-directory"
              value={wba.signatureAgent ?? ""}
              settingKey={BOT_AUTH_KEY}
              onCommit={(v) => {
                const { signatureAgent: _old, ...rest } = wba;
                onChange(BOT_AUTH_KEY, v === "" ? rest : { ...rest, signatureAgent: v });
              }}
            />
            <Facts
              items={[
                {
                  term: t("settings.browser.fingerprint"),
                  value: hasKey ? (
                    <code className="font-mono text-callout" data-testid="bot-auth-fingerprint">
                      {botAuth?.keyId}
                    </code>
                  ) : (
                    t("settings.browser.noKey")
                  ),
                },
                ...(botAuth?.createdAt
                  ? [{ term: t("settings.browser.created"), value: botAuth.createdAt.slice(0, 10) }]
                  : []),
                {
                  term: t("settings.browser.sitesAsked"),
                  value:
                    botAuth && botAuth.advertised.length > 0
                      ? botAuth.advertised.join(", ")
                      : t("settings.browser.noneYet"),
                },
              ]}
            />
            {onRotateBotAuth ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rotating}
                  onClick={() => {
                    setRotated(null);
                    setRotating(true);
                    onRotateBotAuth()
                      .then(
                        () =>
                          setRotated({
                            kind: "ok",
                            text: hasKey
                              ? t("settings.browser.rotated")
                              : t("settings.browser.keyCreated"),
                          }),
                        (err: unknown) =>
                          setRotated({
                            kind: "error",
                            text: t("settings.browser.rotateFailed", {
                              hasKey,
                              reason: messageOf(err),
                            }),
                          }),
                      )
                      .finally(() => setRotating(false));
                  }}
                >
                  <KeyRound aria-hidden="true" />{" "}
                  {hasKey ? t("settings.browser.rotateKey") : t("settings.browser.createKey")}
                </Button>
              </div>
            ) : null}
            {rotated ? (
              rotated.kind === "error" ? (
                <ErrorNotice what={rotated.text} did={t("settings.browser.keyStillSigns")} />
              ) : (
                <p role="status" className="rounded-md bg-gray-3 px-3 py-2">
                  {rotated.text}
                </p>
              )
            ) : null}
          </Group>
        </Advanced>
      </LoadGate>
    </SectionFrame>
  );
}

export function BrowserSection({
  onOpenProfile,
  signedInSites,
  cookieImport,
  teachStorage,
}: {
  onOpenProfile?: (profile: string) => Promise<{ path: string }>;
  signedInSites?: SignedInSitesApi;
  cookieImport?: CookieImportApi;
  teachStorage?: TeachStorageStatus;
}): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const named = useSlots().persona?.name;
  const call = useCall();
  const botAuthQ = useGatewayQuery("browser.botAuth.status", {});
  const agentQ = useGatewayQuery("browser.settings.get", {});
  return (
    <div className="flex flex-col gap-3">
      <BrowserPanel
        agentSettings={agentQ.data ?? null}
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        profileLabel={realChromeProfileLabel(named)}
        {...(onOpenProfile ? { onOpenProfile } : {})}
        {...(signedInSites ? { signedInSites } : {})}
        {...(cookieImport ? { cookieImport } : {})}
        {...(teachStorage ? { teachStorage } : {})}
        botAuth={botAuthQ.data?.status ?? null}
        onRotateBotAuth={() => call("browser.botAuth.rotate", {}).then(() => botAuthQ.reload())}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
