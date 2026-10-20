import type { BotAuthStatus } from "@psyche/protocol";
import { ExternalLink, KeyRound } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import {
  ErrorNotice,
  Facts,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
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
  return persona ? `Psyche profile (${persona})` : "Psyche profile";
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
}

export function BrowserPanel({
  values,
  onChange,
  needsApproval,
  persona,
  profileLabel = "Psyche profile",
  onOpenProfile,
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
      title="Browser"
      description={`${persona} browses in its own window by default. Real-Chrome mode lets a task use a separate Chrome profile you sign in to once.`}
    >
      <LoadGate
        label="browser settings"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title="Real-Chrome mode"
          description="For sites that need your sign-ins or extensions such as 1Password."
        >
          <SwitchField
            label={`Let tasks use the ${profileLabel}`}
            description="Each task still asks you first, on this device with Touch ID or a passkey."
            checked={setting.enabled}
            settingKey={REAL_CHROME_KEY}
            onChange={(enabled) => onChange(REAL_CHROME_KEY, { ...setting, enabled })}
          />
        </Group>
        <Group
          title={profileLabel[0]?.toUpperCase() + profileLabel.slice(1)}
          description={`A Chrome profile only ${persona} uses, never your own. Open it once to sign in and install 1Password, then close it.`}
        >
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-1">
              While a task uses it, Psyche runs Google Chrome with this profile and a DevTools port
              on this Mac's loopback (127.0.0.1), and closes it when the task is done. {persona} is
              not attached while you have the profile open yourself.
            </p>
            <p className="mt-1">
              Profile <code className="font-mono">{profile}</code> in{" "}
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
                    (r) => setOpened({ kind: "ok", text: `Opened ${r.path} in Google Chrome.` }),
                    (err: unknown) =>
                      setOpened({
                        kind: "error",
                        text: `Psyche couldn't open the profile (${messageOf(err)}).`,
                      }),
                  );
                }}
              >
                <ExternalLink aria-hidden="true" /> Open the profile in Chrome
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Open it from the Psyche app on the Mac that runs the Gateway.
            </p>
          )}
          {opened ? (
            opened.kind === "error" ? (
              <ErrorNotice what={opened.text} did="Nothing was changed." />
            ) : (
              <p role="status" className="rounded-md bg-gray-3 px-3 py-2">
                {opened.text}
              </p>
            )
          ) : null}
        </Group>
        <Group
          title="Web Bot Auth"
          description={`Sign ${persona}'s requests so sites that check, such as Cloudflare's verified bots, can tell it apart from an unknown bot. Never in tasks that browse logged out.`}
        >
          <SwitchField
            label="Sign requests for sites that ask"
            description="Also for the sites you list. Needs a key and a key directory URL."
            checked={wba.enabled}
            settingKey={BOT_AUTH_KEY}
            onChange={(enabled) => onChange(BOT_AUTH_KEY, { ...wba, enabled })}
          />
          <TextSetting
            label="Key directory URL"
            description={
              <>
                Where sites fetch your public key. The Gateway serves it at{" "}
                <code className="font-mono">
                  {botAuth?.directoryPath ?? "/.well-known/http-message-signatures-directory"}
                </code>
                ; publish that on a domain you control and enter its address here.
              </>
            }
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
                term: "Key fingerprint",
                value: hasKey ? (
                  <code className="font-mono text-xs" data-testid="bot-auth-fingerprint">
                    {botAuth?.keyId}
                  </code>
                ) : (
                  "No key yet"
                ),
              },
              ...(botAuth?.createdAt
                ? [{ term: "Created", value: botAuth.createdAt.slice(0, 10) }]
                : []),
              {
                term: "Sites that asked",
                value:
                  botAuth && botAuth.advertised.length > 0
                    ? botAuth.advertised.join(", ")
                    : "None yet",
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
                            ? "A new key is in place and the old one no longer signs. Update the directory you publish."
                            : "Key created. Publish the directory, then enter its address above.",
                        }),
                      (err: unknown) =>
                        setRotated({
                          kind: "error",
                          text: `Psyche couldn't ${hasKey ? "rotate" : "create"} the key (${messageOf(err)}).`,
                        }),
                    )
                    .finally(() => setRotating(false));
                }}
              >
                <KeyRound aria-hidden="true" /> {hasKey ? "Rotate key" : "Create key"}
              </Button>
            </div>
          ) : null}
          {rotated ? (
            rotated.kind === "error" ? (
              <ErrorNotice what={rotated.text} did="The current key, if any, still signs." />
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
}: {
  onOpenProfile?: (profile: string) => Promise<{ path: string }>;
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
