import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { PluginSummarySchema } from "@psyche/protocol";
import { FolderOpen } from "lucide-react";
import { type ReactElement, useState } from "react";
import { GroupedList, GroupedRow } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import { TrustApproval } from "./SkillsSection.tsx";
import { approvalIdOf, messageOf } from "./shared.tsx";

/**
 * Settings → Skills → Plugins (`plugins.*`): installed code plugins with their status, what they
 * add, an on/off switch and remove. Install starts from a picked folder (desktop only) and goes
 * through the proposal and its approval card. A switch that the Gateway holds for approval only waits.
 */

const show = (s: string, max = 200) => sanitizeDisplay(s, max);

/** The protocol's `PluginCapability` values, in the words the rows use. */
const CAPABILITY_IDS = [
  "context",
  "before_tool_call",
  "after_tool_call",
  "agent_end",
  "evaluate",
] as const;

export function PluginsSection({
  onPickFolder,
}: {
  /** The desktop folder chooser; without it (web) there is no install button. */
  onPickFolder?: () => Promise<string | null>;
} = {}): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("plugins.list", {});
  const [pending, setPending] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);
  // The install's trust card: `plugins.install` runs only after its approval (same as skills).
  const [review, setReview] = useState<{ proposalId: string; approvalId: string } | null>(null);

  const setEnabled = (plugin: PluginSummarySchema, enabled: boolean) => {
    setPending(plugin.name);
    setWaiting(false);
    setActionError(null);
    call("plugins.setEnabled", { name: plugin.name, enabled })
      .then(
        () => q.reload(),
        (err: unknown) => {
          // The Gateway holds the change for the owner's answer on the device. Show that it
          // waits; the switch stays where it was until the answer lands.
          if (approvalIdOf(err) !== null) return setWaiting(true);
          setActionError(t("settings.plugins.failed", { reason: messageOf(err) }));
        },
      )
      .finally(() => setPending(null));
  };

  const remove = (plugin: PluginSummarySchema) => {
    setWaiting(false);
    setActionError(null);
    call("plugins.remove", { name: plugin.name }).then(
      () => q.reload(),
      (err: unknown) => setActionError(t("settings.plugins.failed", { reason: messageOf(err) })),
    );
  };

  const install = () => {
    if (onPickFolder === undefined) return;
    setActionError(null);
    setProposed(false);
    onPickFolder().then(
      (path) => {
        if (path === null) return;
        call("plugins.proposeInstall", { path }).then(
          (r) => {
            setProposed(true);
            setReview({ proposalId: r.proposal.id, approvalId: r.approval.id });
          },
          (err: unknown) =>
            setActionError(t("settings.plugins.installFailed", { reason: messageOf(err) })),
        );
      },
      (err: unknown) =>
        setActionError(t("settings.plugins.pickFailed", { reason: messageOf(err) })),
    );
  };

  // The card's verdict. Only an approval installs; a denied or lapsed card installs nothing.
  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = review;
    if (current === null) return;
    setReview(null);
    setProposed(false);
    if (status !== "approved") return;
    setActionError(null);
    call("plugins.install", {
      proposalId: current.proposalId,
      approvalId: current.approvalId,
    }).then(
      () => q.reload(),
      (err: unknown) =>
        setActionError(t("settings.plugins.installNotDone", { reason: messageOf(err) })),
    );
  };

  const plugins = q.data?.plugins ?? [];
  const loading = q.loading && q.data === undefined;

  return (
    <GroupedList title={t("settings.plugins.title")} footer={t("settings.plugins.description")}>
      {q.data !== undefined && !q.data.enabled ? (
        <p role="note" className="px-3 py-2 text-callout text-label-secondary">
          {t("settings.plugins.off")}
        </p>
      ) : null}
      {onPickFolder !== undefined ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <Button type="button" variant="outline" size="sm" onClick={install}>
            <FolderOpen aria-hidden="true" />
            {t("settings.plugins.install")}
          </Button>
        </div>
      ) : null}
      {proposed ? (
        <p role="status" className="px-3 py-2 text-callout text-label-secondary">
          {t("settings.plugins.proposed")}
        </p>
      ) : null}
      {actionError !== null ? (
        <p role="alert" className="px-3 py-2 text-callout text-danger-text">
          {actionError}
        </p>
      ) : null}
      {review !== null ? (
        <div className="px-3 py-2">
          <TrustApproval
            key={review.approvalId}
            approvalId={review.approvalId}
            onDecided={decided}
          />
        </div>
      ) : null}
      {waiting ? (
        <p role="status" className="px-3 py-2 text-callout text-label-secondary">
          {t("settings.plugins.waitingApproval")}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="px-3 py-3 text-callout text-label-secondary">
          {t("settings.plugins.loading")}
        </p>
      ) : q.error ? (
        <div className="flex flex-col items-start gap-2 px-3 py-3">
          <p role="alert" className="text-callout text-danger-text">
            {t("settings.plugins.error", { reason: q.error })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={q.reload}>
            {t("common.retry")}
          </Button>
        </div>
      ) : plugins.length === 0 ? (
        <p className="px-3 py-3 text-callout text-label-secondary">{t("settings.plugins.empty")}</p>
      ) : (
        <ul className="flex flex-col" aria-label={t("settings.plugins.title")}>
          {plugins.map((plugin) => (
            <li key={plugin.name} data-testid={`plugin-${plugin.name}`}>
              <GroupedRow
                label={
                  <>
                    {plugin.name}
                    <span className="text-label-secondary">
                      {t("settings.plugins.version", { version: show(plugin.version, 64) })}
                    </span>
                  </>
                }
                description={<PluginDetails plugin={plugin} />}
                control={
                  <>
                    <Switch
                      aria-label={t("settings.plugins.switchOn", { name: show(plugin.name, 64) })}
                      checked={plugin.enabled}
                      disabled={pending === plugin.name}
                      onCheckedChange={(v) => setEnabled(plugin, v)}
                    />
                    <RowMoreMenu
                      name={show(plugin.name, 64)}
                      destructive={[
                        {
                          label: t("common.remove"),
                          title: t("settings.plugins.removeTitle", { name: show(plugin.name, 64) }),
                          description: t("settings.plugins.removeDescription"),
                          confirm: t("common.remove"),
                          onConfirm: () => remove(plugin),
                        },
                      ]}
                    />
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </GroupedList>
  );
}

function PluginDetails({ plugin }: { plugin: PluginSummarySchema }): ReactElement {
  const labels = plugin.capabilities
    .filter((c): c is (typeof CAPABILITY_IDS)[number] =>
      (CAPABILITY_IDS as readonly string[]).includes(c),
    )
    .map((c) => t(`settings.plugins.capability.${c}`));
  const adds = new Intl.ListFormat(activeI18n().locale, {
    style: "long",
    type: "conjunction",
  }).format(labels);
  const a = plugin.adds;
  const counts =
    a === undefined
      ? []
      : (["skills", "commands", "mcpServers", "hooks"] as const)
          .filter((k) => a[k] > 0)
          .map((k) => t(`settings.plugins.count.${k}`, { n: a[k] }));
  return (
    <span className="flex flex-col gap-0.5">
      <span>{show(plugin.description, 300)}</span>
      <span>{t("settings.plugins.adds", { list: adds })}</span>
      {counts.length > 0 ? (
        <span>
          {t("settings.plugins.includes", {
            list: new Intl.ListFormat(activeI18n().locale, {
              style: "long",
              type: "conjunction",
            }).format(counts),
          })}
        </span>
      ) : null}
      <span>
        {t("settings.plugins.from", { source: show(plugin.source, 300) })}
        {" · "}
        {t(`settings.plugins.state.${plugin.status}`)}
      </span>
      {plugin.error ? <span className="text-danger-text">{show(plugin.error, 300)}</span> : null}
    </span>
  );
}
