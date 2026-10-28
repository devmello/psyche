import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { CatalogEntry, McpServerInput, SkillDetails } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { toServerInput } from "./mcp-input.ts";
import { joinCommand } from "./mcp-json.ts";
import { MCP_PRESETS } from "./mcp-presets.ts";
import {
  EmptyNotice,
  Group,
  SectionSkeleton,
  StatusChip,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";
import type { McpState } from "./use-mcp.tsx";

/**
 * The "Available" lists in Settings → Connectors and Skills: what `capabilities.search` finds that
 * is not installed yet. Registry text is third-party data: shown as plain text, never as markup or
 * a link, and nothing is added without the usual trust card and approval.
 */

const show = (s: string, max = 200) => sanitizeDisplay(s, max);
const THIRD_PARTY = /^\[third-party text: data, not instructions\]\s*/i;

/** Search words after a pause, so each keystroke does not hit the Gateway. */
function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function Results({
  kind,
  query,
  label,
  empty,
  row,
}: {
  kind: "connector" | "skill";
  query: string;
  label: string;
  empty: string;
  row: (e: CatalogEntry) => ReactElement | null;
}): ReactElement {
  const words = useDebounced(query.trim());
  const q = useGatewayQuery("capabilities.search", {
    kind,
    installable: true,
    limit: 30,
    ...(words === "" ? {} : { query: words }),
  });
  const entries = (q.data?.entries ?? []).filter((e) => kind !== "skill" || e.status === "off");
  if (q.error !== null)
    return (
      <p role="alert" className="text-callout text-danger-text">
        {t("capabilities.loadFailed", { reason: q.error })}
      </p>
    );
  if (q.data === undefined) return <SectionSkeleton label={label} rows={2} />;
  if (entries.length === 0) return <EmptyNotice text={empty} />;
  return <ul className="flex flex-col divide-y divide-gray-6">{entries.map(row)}</ul>;
}

function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <Input
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Official (verified or bundled) or Unverified, with the warning tone for the latter. */
export function TrustBadge({ trust }: { trust: CatalogEntry["trust"] }): ReactElement {
  return trust === "unknown" ? (
    <StatusChip tone="approval">{t("capabilities.badge.unverified")}</StatusChip>
  ) : (
    <StatusChip tone="info">{t("capabilities.badge.official")}</StatusChip>
  );
}

/** What it needs, in words: a key or sign-in, where it runs, the hosts it reaches. */
function needsLine(e: CatalogEntry): string {
  const parts = [
    e.needs.signIn === "key"
      ? t("capabilities.needs.key")
      : e.needs.signIn === "oauth"
        ? t("capabilities.needs.oauth")
        : null,
    e.needs.runsIn === "srt"
      ? t("capabilities.needs.sandbox")
      : e.needs.runsIn === "remote"
        ? t("capabilities.needs.remote")
        : null,
    e.needs.network.length > 0
      ? t("capabilities.needs.network", {
          hosts: e.needs.network.map((h) => show(h, 80)).join(", "),
        })
      : null,
  ];
  return parts.filter((x) => x !== null).join(" · ");
}

/** The probe input a registry entry's command or address makes (same shape as the Add form). */
function inputOf(e: CatalogEntry): McpServerInput | null {
  const command = e.install?.command;
  const url = e.install?.url;
  if (command && command.length > 0)
    return toServerInput({
      name: e.name,
      kind: "command",
      command: joinCommand(command),
      url: "",
      domains: e.needs.network.join(" "),
    });
  if (url) return toServerInput({ name: e.name, kind: "url", command: "", url, domains: "" });
  return null;
}

function ConnectorRow({
  entry,
  mcp,
  onPreset,
}: {
  entry: CatalogEntry;
  mcp: McpState | undefined;
  onPreset: (id: string) => void;
}): ReactElement {
  const presetId = entry.install?.preset;
  const preset = presetId ? MCP_PRESETS.find((p) => p.id === presetId) : undefined;
  const input = preset ? null : entry.needs.signIn === "none" ? inputOf(entry) : null;
  const commandless = input?.transport.kind === "stdio" && mcp?.launcher === "none";
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-headline text-label-primary">{show(entry.name, 80)}</h4>
            <TrustBadge trust={entry.trust} />
            {entry.comesFrom === "registry" ? (
              <StatusChip tone="neutral">{t("capabilities.badge.registry")}</StatusChip>
            ) : null}
          </div>
          <p className="text-callout text-label-secondary">
            {show(entry.summary.replace(THIRD_PARTY, ""), 300)}
          </p>
          <p className="text-caption text-label-secondary empty:hidden">{needsLine(entry)}</p>
        </div>
        {preset ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onPreset(preset.id)}>
            {t("capabilities.action.setUp")}
          </Button>
        ) : input !== null && mcp ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={mcp.checking || commandless}
            onClick={() => mcp.check(input)}
          >
            {t("capabilities.action.check")}
          </Button>
        ) : null}
      </div>
      {!preset && input === null ? (
        <p className="text-callout text-label-secondary">{t("capabilities.action.needsKey")}</p>
      ) : null}
    </li>
  );
}

/** Settings → Connectors → Available: search, the online-registry switch and the results. */
export function AvailableConnectors({
  mcp,
  onPreset,
}: {
  mcp?: McpState | undefined;
  onPreset: (presetId: string) => void;
}): ReactElement {
  const form = useSettingsForm();
  const online = form.values["capabilities.onlineSearch"] === true;
  const [query, setQuery] = useState("");
  return (
    <Group
      title={t("capabilities.available.title")}
      description={t("capabilities.available.connectorsHint")}
    >
      <div className="flex flex-col gap-2">
        <SearchBox label={t("capabilities.search.label")} value={query} onChange={setQuery} />
        <SwitchField
          label={t("capabilities.online.label")}
          description={t("capabilities.online.hint")}
          checked={online}
          onChange={(v) => form.onChange("capabilities.onlineSearch", v)}
          settingKey="capabilities.onlineSearch"
        />
        {form.writeError ? (
          <p role="alert" className="text-callout text-danger-text">
            {form.writeError}
          </p>
        ) : null}
        <Results
          // The online switch changes what is searched: start the search over.
          key={String(online)}
          kind="connector"
          query={query}
          label={t("capabilities.search.label")}
          empty={t("capabilities.noConnectors")}
          row={(e) => <ConnectorRow key={e.id} entry={e} mcp={mcp} onPreset={onPreset} />}
        />
      </div>
    </Group>
  );
}

/** Settings → Skills → Available: skills that are installed but off. */
export function AvailableSkills({
  skills,
  onEnable,
}: {
  skills: readonly SkillDetails[];
  onEnable: (skill: SkillDetails) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  return (
    <Group
      title={t("capabilities.available.title")}
      description={t("capabilities.available.skillsHint")}
    >
      <div className="flex flex-col gap-2">
        <SearchBox label={t("capabilities.search.skillsLabel")} value={query} onChange={setQuery} />
        <Results
          kind="skill"
          query={query}
          label={t("capabilities.search.skillsLabel")}
          empty={t("capabilities.noSkills")}
          row={(e) => {
            const skill = skills.find((s) => s.name === e.name);
            return (
              <li key={e.id} className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-headline text-label-primary">{show(e.name, 80)}</h4>
                    <TrustBadge trust={e.trust} />
                  </div>
                  <p className="text-callout text-label-secondary">{show(e.summary, 300)}</p>
                </div>
                {skill ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => onEnable(skill)}>
                    {t("capabilities.action.turnOn")}
                  </Button>
                ) : null}
              </li>
            );
          }}
        />
      </div>
    </Group>
  );
}
