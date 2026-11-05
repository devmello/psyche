import { type ReactElement, useContext, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { groupFingerprint, pinFingerprint } from "../../lib/fingerprint.ts";
import {
  approvalIdOf,
  Facts,
  Group,
  LoadGate,
  messageOf,
  RadioField,
  SettingsApprovalContext,
  StatusChip,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Server & remote access → Allow computers on this network (remote-gateway design
 * §3.1, "LAN"). Off by default. When on, the Gateway also listens on the chosen network
 * interface (the primary Wi-Fi or Ethernet by default) over TLS with its own certificate, and
 * says so on the network with Bonjour. Computers on the network pin the certificate and the
 * Gateway's key and still need the owner's approval. The choice is the `gateway.lan` setting
 * (admin plus Touch ID, like every Gateway setting); replacing the certificate makes every
 * paired computer pair again.
 */

const LAN_SETTING = "gateway.lan";
const LAN_CERT_SETTING = "gateway.lan.rotateCert";
const PRIMARY = "";

function problemText(problem: string): string {
  const [kind = "", ...rest] = problem.split(":");
  switch (kind) {
    case "unknown_interface":
      return t("settings.lan.problem.unknownInterface", { name: rest.join(":") });
    case "ipv6_off":
      return t("settings.lan.problem.ipv6Off", { address: rest.join(":") });
    case "ipv6_needs_ipv4":
      return t("settings.lan.problem.ipv6NeedsIpv4", { address: rest.join(":") });
    case "no_interface":
      return t("settings.lan.problem.noInterface");
    case "bind_failed":
      // `bind_failed:<address>:<code>`, and an IPv6 address has colons of its own.
      return t("settings.lan.problem.bindFailed", { address: rest.slice(0, -1).join(":") });
    case "network_paused":
      return t("settings.lan.problem.paused");
    case "cert_unavailable":
      return t("settings.lan.problem.cert");
    case "cloudflare_access":
      return t("settings.lan.problem.cloudflare");
    case "container_bind":
      return t("settings.lan.problem.container");
    default:
      return t("settings.lan.problem.advertise");
  }
}

function RotateCertificate({ onRotated }: { onRotated: () => void }): ReactElement {
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (approvalId?: string) => {
    await call("gateway.lan.rotateCert", approvalId === undefined ? {} : { approvalId });
    onRotated();
  };
  const go = () => {
    setBusy(true);
    setError(null);
    run().then(
      () => {
        setBusy(false);
        setConfirming(false);
      },
      (err: unknown) => {
        setBusy(false);
        const id = approvalIdOf(err);
        if (id !== null && requestApproval) {
          setConfirming(false);
          requestApproval({ key: LAN_CERT_SETTING, approvalId: id, retry: (aid) => run(aid) });
        } else {
          setError(t("settings.lan.rotateFailed", { reason: messageOf(err) }));
        }
      },
    );
  };
  if (!confirming) {
    return (
      <span className="flex flex-col gap-1.5">
        <span>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            {t("settings.lan.rotate")}
          </Button>
        </span>
        {error ? (
          <p role="alert" className="text-footnote text-danger-text">
            {error}
          </p>
        ) : null}
      </span>
    );
  }
  return (
    <section
      aria-label={t("settings.lan.rotateTitle")}
      className="flex flex-col gap-2 rounded-md border border-separator px-3 py-2"
    >
      <p className="text-callout font-medium text-label-primary">{t("settings.lan.rotateTitle")}</p>
      <p className="text-callout text-label-secondary">{t("settings.lan.rotateBody")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={go}>
          {t("settings.lan.rotateConfirm")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          {t("common.cancel")}
        </Button>
      </div>
    </section>
  );
}

export function LanAccessGroup(): ReactElement {
  const info = useGatewayQuery("gateway.info", {});
  const form = useSettingsForm();
  const lan = info.data?.lan;
  const stored = form.values[LAN_SETTING];
  const { reload } = info;
  // The Gateway opens or closes the sockets when the setting is saved; read the result again.
  useEffect(() => {
    void stored;
    reload();
  }, [stored, reload]);

  const choice = lan?.interfaces[0] ?? PRIMARY;
  const ipv6 = lan?.ipv6 === true;
  const write = (enabled: boolean, interfaces: string[], withIpv6: boolean = ipv6) =>
    form.onChange(LAN_SETTING, {
      enabled,
      interfaces,
      port: lan?.port ?? 7979,
      ipv6: withIpv6,
    });
  const allCandidates = lan?.candidates ?? [];
  // IPv6 addresses are listed as something that is bound only while the switch is on.
  const candidates = ipv6 ? allCandidates : allCandidates.filter((c) => !c.address.includes(":"));
  const primary = candidates.find((c) => c.isDefault);
  // One row per interface, listing its addresses (an interface can have IPv4 and IPv6 ones).
  const others = new Map<string, string[]>();
  for (const c of candidates) {
    if (c.name === primary?.name) continue;
    others.set(c.name, [...(others.get(c.name) ?? []), c.address]);
  }
  const offersIpv6 = allCandidates.some((c) => c.address.includes(":"));
  const options = [
    {
      value: PRIMARY,
      label: t("settings.lan.interfaceDefault"),
      hint:
        candidates.find((c) => c.isDefault) === undefined
          ? t("settings.lan.noInterface")
          : t("settings.lan.interfaceOption", {
              name: primary?.name ?? "",
              address: candidates
                .filter((c) => c.name === primary?.name)
                .map((c) => c.address)
                .join(", "),
            }),
    },
    ...[...others].map(([name, addresses]) => ({
      value: name,
      label: t("settings.lan.interfaceOption", { name, address: addresses.join(", ") }),
    })),
  ];

  return (
    <Group title={t("settings.lan.title")} description={t("settings.lan.description")}>
      <LoadGate
        label={t("settings.lan.loadLabel")}
        loading={info.loading && info.data === undefined}
        error={info.error}
        onRetry={info.reload}
      >
        {lan === undefined ? (
          <p className="text-callout text-label-secondary">{t("settings.lan.unsupported")}</p>
        ) : (
          <>
            <SwitchField
              label={t("settings.lan.toggle")}
              description={t("settings.lan.toggleHint")}
              settingKey={LAN_SETTING}
              checked={lan.enabled}
              onChange={(on) => write(on, lan.interfaces)}
            />
            {candidates.length > 0 ? (
              <RadioField
                grouped
                label={t("settings.lan.interface")}
                value={options.some((o) => o.value === choice) ? choice : PRIMARY}
                options={options}
                onChange={(v) => write(lan.enabled, v === PRIMARY ? [] : [v])}
              />
            ) : (
              <p className="text-callout text-label-secondary">{t("settings.lan.noInterface")}</p>
            )}
            {offersIpv6 || ipv6 ? (
              <SwitchField
                label={t("settings.lan.ipv6")}
                description={t("settings.lan.ipv6Hint")}
                settingKey={LAN_SETTING}
                checked={ipv6}
                onChange={(on) => write(lan.enabled, lan.interfaces, on)}
              />
            ) : null}
            {lan.enabled ? (
              <p className="text-callout text-approval-text">{t("settings.lan.trustedOnly")}</p>
            ) : null}
            {lan.problems.map((p) => (
              <p key={p} role="status" className="text-callout text-danger-text">
                {problemText(p)}
              </p>
            ))}
            {lan.problems.includes("network_paused") ? (
              <span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => write(true, lan.interfaces)}
                >
                  {t("settings.lan.allowHere")}
                </Button>
              </span>
            ) : null}
            {lan.enabled ? (
              <Facts
                items={[
                  {
                    term: t("settings.lan.status"),
                    value:
                      lan.listening.length > 0 ? (
                        <StatusChip tone="success">
                          {t("settings.lan.listening", {
                            addresses: lan.listening
                              .map((l) => `${l.address}:${l.port}`)
                              .join(", "),
                          })}
                        </StatusChip>
                      ) : (
                        <StatusChip tone="neutral">{t("settings.lan.notListening")}</StatusChip>
                      ),
                  },
                  ...(lan.origin
                    ? [
                        {
                          term: t("settings.lan.address"),
                          value: <code className="font-mono text-callout">{lan.origin}</code>,
                        },
                      ]
                    : []),
                  {
                    term: t("settings.lan.discovery"),
                    value: lan.advertising
                      ? t("settings.lan.advertised")
                      : t("settings.lan.notAdvertised"),
                  },
                  ...(lan.certSpki
                    ? [
                        {
                          term: t("settings.lan.certificate"),
                          value: (
                            <span className="flex flex-col gap-0.5">
                              <code className="font-mono text-callout">
                                {groupFingerprint(pinFingerprint(lan.certSpki))}
                              </code>
                              <span className="text-callout text-label-secondary">
                                {t("settings.lan.certificateHint")}
                              </span>
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
            {lan.enabled && lan.certSpki ? <RotateCertificate onRotated={reload} /> : null}
          </>
        )}
      </LoadGate>
      {form.writeError ? <p className="text-callout text-danger-text">{form.writeError}</p> : null}
    </Group>
  );
}
