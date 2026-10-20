import { ExternalLink } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { usePersona, useSlots } from "../../slots.tsx";
import {
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
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

export interface BrowserPanelProps extends SettingsFormProps, LoadProps {
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
  loading,
  error,
  onRetry,
}: BrowserPanelProps): ReactElement {
  const setting = realChromeOf(values);
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
  return (
    <div className="flex flex-col gap-3">
      <BrowserPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        profileLabel={realChromeProfileLabel(named)}
        {...(onOpenProfile ? { onOpenProfile } : {})}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
