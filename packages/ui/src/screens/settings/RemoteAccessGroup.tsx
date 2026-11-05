import { DEFAULT_GATEWAY_PORT } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { groupFingerprint } from "../../lib/fingerprint.ts";
import { useSlots } from "../../slots.tsx";
import { Facts, Group, LoadGate, StatusChip } from "./shared.tsx";

/**
 * Settings → Server & remote access → Allow other computers (remote-gateway design §3.1).
 * How to let Psyche on another computer use this Mac's Gateway over Tailscale Serve. Psyche does
 * not run `tailscale` or edit the Gateway's configuration for the owner: it shows the exact
 * command and the two settings, and the Gateway stays on loopback. The panel also shows what
 * the Gateway answers to, and the identity key's fingerprint the owner compares with the new
 * computer's screen before approving it.
 */

export const SERVE_COMMAND = `tailscale serve --bg --https=443 http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;

export const CONFIG_EXAMPLE = `{
  "gateway": {
    "publicOrigin": "https://<this-computer>.<tailnet>.ts.net",
    "trustedProxy": { "enabled": true, "trustedProxies": ["127.0.0.1", "::1"] }
  }
}`;

function CopyButton({ text }: { text: string }): ReactElement | null {
  const { writeClipboard } = useSlots();
  const [done, setDone] = useState(false);
  if (!writeClipboard) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() =>
        void writeClipboard(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        })
      }
    >
      {done ? t("settings.remote.copied") : t("settings.remote.copyCommand")}
    </Button>
  );
}

export function RemoteAccessGroup(): ReactElement {
  const info = useGatewayQuery("gateway.info", {});
  const data = info.data;
  return (
    <Group title={t("settings.remote.title")} description={t("settings.remote.description")}>
      <LoadGate
        label={t("settings.remote.loadLabel")}
        loading={info.loading && data === undefined}
        error={info.error}
        onRetry={info.reload}
      >
        <ol className="flex list-decimal flex-col gap-3 ps-5 text-label-primary">
          <li>{t("settings.remote.step1")}</li>
          <li className="flex flex-col gap-1.5">
            <span>{t("settings.remote.step2")}</span>
            <span className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-gray-4 px-2 py-1 font-mono text-callout">
                {SERVE_COMMAND}
              </code>
              <CopyButton text={SERVE_COMMAND} />
            </span>
          </li>
          <li className="flex flex-col gap-1.5">
            <span>{t("settings.remote.step3")}</span>
            <span className="flex flex-wrap items-start gap-2">
              <pre className="rounded bg-gray-4 px-2 py-1 font-mono text-callout">
                {CONFIG_EXAMPLE}
              </pre>
              <CopyButton text={CONFIG_EXAMPLE} />
            </span>
          </li>
          <li>{t("settings.remote.step4")}</li>
        </ol>
        <p className="text-callout text-approval-text">{t("settings.remote.funnel")}</p>
        <p className="text-callout text-label-secondary">{t("settings.remote.admin")}</p>
        {data ? (
          <Facts
            items={[
              {
                term: t("settings.remote.address"),
                value: data.publicOrigin ? (
                  <code className="font-mono text-callout">{data.publicOrigin}</code>
                ) : (
                  t("settings.remote.addressUnset")
                ),
              },
              {
                term: t("settings.remote.proxy"),
                value: (
                  <StatusChip tone={data.trustedProxy ? "success" : "neutral"}>
                    {data.trustedProxy ? t("settings.remote.on") : t("settings.remote.off")}
                  </StatusChip>
                ),
              },
              {
                term: t("settings.remote.fingerprint"),
                value: (
                  <span className="flex flex-col gap-0.5">
                    <code className="font-mono text-callout">
                      {groupFingerprint(data.identity.fingerprint)}
                    </code>
                    <span className="text-callout text-label-secondary">
                      {t("settings.remote.fingerprintHint")}
                    </span>
                  </span>
                ),
              },
            ]}
          />
        ) : null}
      </LoadGate>
    </Group>
  );
}
