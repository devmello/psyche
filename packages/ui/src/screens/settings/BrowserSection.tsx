import type { BotAuthStatus } from "@psyche/protocol";
import { ExternalLink, KeyRound } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { LINK_OPEN_SETTING, type LinkOpenMode, linkOpenMode } from "../../links/link-policy.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import {
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

/** A site kept signed in, in the persistent profile (desktop only). */
export interface SignedInSite {
  origin: string;
  hosts: string[];
  addedAt: string;
}

export interface SignedInSitesApi {
  list(): Promise<SignedInSite[]>;
  /** Removes the site from the list and deletes its cookies from the profile. */
  forget(origin: string): Promise<void>;
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
              {s.hosts.length > 1 ? (
                <span className="block text-xs text-muted-foreground">
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

export interface BrowserPanelProps extends SettingsFormProps, LoadProps {
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
}

export function BrowserPanel({
  values,
  onChange,
  needsApproval,
  persona,
  profileLabel = t("settings.browser.profile"),
  onOpenProfile,
  signedInSites,
  botAuth,
  onRotateBotAuth,
  loading,
  error,
  onRetry,
}: BrowserPanelProps): ReactElement {
  const setting = realChromeOf(values);
  const wba = botAuthOf(values);
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
          <details className="text-xs text-muted-foreground">
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
        {signedInSites ? <SignedInSitesGroup api={signedInSites} /> : null}
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
                  <code className="font-mono text-xs" data-testid="bot-auth-fingerprint">
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
      </LoadGate>
    </SectionFrame>
  );
}

export function BrowserSection({
  onOpenProfile,
  signedInSites,
}: {
  onOpenProfile?: (profile: string) => Promise<{ path: string }>;
  signedInSites?: SignedInSitesApi;
}): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const named = useSlots().persona?.name;
  const call = useCall();
  const botAuthQ = useGatewayQuery("browser.botAuth.status", {});
  return (
    <div className="flex flex-col gap-3">
      <BrowserPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        profileLabel={realChromeProfileLabel(named)}
        {...(onOpenProfile ? { onOpenProfile } : {})}
        {...(signedInSites ? { signedInSites } : {})}
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
