import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ConnectorBundleCard as Card } from "@psyche/protocol";
import { ShieldAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { Facts, StatusChip } from "./shared.tsx";

/**
 * The card for a connector someone shared as a file (docs/design/shared-bundles-2026.md section
 * 8). Everything on it is the author's words, shown as data: who signed it, the command, the
 * network, the names of the variables and secrets it needs, the tools it says it lists, any
 * scripts that come with it, and for an update what it asks for beyond the installed version. It
 * says plainly where it runs the first time, and when it cannot run here at all.
 */

const show = (s: string, max = 300) => sanitizeDisplay(s, max);
const TIER_TONE = { read: "info", write: "approval", destructive: "danger" } as const;

function signerLine(card: Card): { text: string; warn: boolean } {
  const s = card.signer;
  const name = show(s.name ?? "", 64);
  if (s.status === "unsigned")
    return {
      text: t(
        s.signerChanged
          ? "settings.connectorBundle.signer.dropped"
          : "settings.connectorBundle.signer.unsigned",
      ),
      warn: s.signerChanged,
    };
  if (s.impersonates === true)
    return { text: t("settings.connectorBundle.signer.impersonates"), warn: true };
  if (s.nameChanged === true)
    return { text: t("settings.connectorBundle.signer.nameChanged", { name }), warn: true };
  const warn = s.status === "changed" || s.status === "revoked" || s.signerChanged;
  return { text: t(`settings.connectorBundle.signer.${s.status}`, { name }), warn };
}

function List({ items, none }: { items: readonly string[]; none: string }): ReactElement {
  if (items.length === 0) return <span className="text-muted-foreground">{none}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((x) => (
        <li key={x}>
          <code>{show(x, 253)}</code>
        </li>
      ))}
    </ul>
  );
}

function WidenedBlock({ card }: { card: Card }): ReactElement | null {
  const w = card.update?.widened;
  if (w === undefined || card.update === undefined) return null;
  const rows: { term: string; value: ReactNode }[] = [];
  if (w.command)
    rows.push({
      term: t("settings.connectorBundle.widened.command"),
      value: t("settings.connectorBundle.widened.commandValue", {
        now: show(card.command.join(" "), 300),
        before: show(card.update.installedCommand.join(" "), 300),
      }),
    });
  const add = (term: string, items: readonly string[]) => {
    if (items.length > 0) rows.push({ term, value: items.map((x) => show(x, 253)).join(", ") });
  };
  add(t("settings.connectorBundle.widened.env"), w.env);
  add(t("settings.connectorBundle.widened.secrets"), w.secrets);
  add(t("settings.connectorBundle.widened.network"), w.network);
  add(t("settings.connectorBundle.widened.tools"), w.tools);
  if (w.payload)
    rows.push({
      term: t("settings.connectorBundle.widened.payload"),
      value: t("settings.connectorBundle.widened.payloadValue"),
    });
  return (
    <section className="flex flex-col gap-2" data-testid="connector-widened">
      <p role="alert" className="flex items-start gap-2 font-medium text-danger-text">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("settings.connectorBundle.widened.title")}
      </p>
      <Facts items={rows} />
      <p className="text-callout text-muted-foreground">
        {t("settings.connectorBundle.widened.hint")}
      </p>
    </section>
  );
}

export function ConnectorBundleCard({
  card,
  children,
  onCancel,
}: {
  card: Card;
  /** The device-only approval under the card, when there is one. */
  children?: ReactNode;
  onCancel: () => void;
}): ReactElement {
  const signer = signerLine(card);
  const tools = card.declaredTools;
  const blocked = card.blocker !== undefined;
  const check = card.toolCheck;
  return (
    <section
      aria-label={t("settings.connectorBundle.title", { name: show(card.title, 64) })}
      data-testid="connector-bundle-card"
      className="flex flex-col gap-4 rounded-lg border border-approval-border bg-gray-2 p-4 text-sm"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">
          {t("settings.connectorBundle.title", { name: show(card.title, 64) })}
        </h3>
        <p className="text-muted-foreground">
          {t(card.update ? "settings.connectorBundle.update" : "settings.connectorBundle.intro")}
        </p>
        {card.description ? (
          // Written by the author: data, never instructions.
          <p className="text-muted-foreground">{show(card.description, 500)}</p>
        ) : null}
      </div>

      <section
        className="flex flex-col gap-2"
        aria-label={t("settings.connectorBundle.signer.title")}
      >
        <h4 className="font-medium">{t("settings.connectorBundle.signer.title")}</h4>
        <p
          {...(signer.warn ? { role: "alert" } : {})}
          className={signer.warn ? "flex items-start gap-2 text-danger-text" : undefined}
          data-testid="connector-signer"
        >
          {signer.warn ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : null}
          {signer.text}
        </p>
        {card.signer.status !== "unsigned" ? (
          <>
            <p className="text-callout text-muted-foreground">
              {t("settings.connectorBundle.signer.claim")}
            </p>
            {card.signer.keyId !== undefined ? (
              <Facts
                items={[
                  {
                    term: t("settings.connectorBundle.signer.key"),
                    value: <code className="break-all">{show(card.signer.keyId, 80)}</code>,
                  },
                ]}
              />
            ) : null}
          </>
        ) : null}
      </section>

      <WidenedBlock card={card} />

      <p
        role={blocked ? "alert" : "status"}
        className={blocked ? "flex items-start gap-2 text-danger-text" : undefined}
        data-testid="connector-sandbox"
      >
        {blocked ? <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : null}
        {card.blocker === "scan"
          ? t("settings.connectorBundle.blocker.scan")
          : t(`settings.connectorBundle.sandbox.${card.sandbox}`)}
      </p>

      <Facts
        items={[
          {
            term: t("settings.connectorBundle.command"),
            value: (
              <div className="flex flex-col gap-1">
                <ol className="flex flex-col gap-0.5">
                  {card.command.map((part, i) => (
                    // The position is the identity: the same word can appear twice.
                    // biome-ignore lint/suspicious/noArrayIndexKey: argv order matters
                    <li key={i}>
                      <code className="break-all">{show(part, 1_000)}</code>
                    </li>
                  ))}
                </ol>
                <p className="text-callout text-muted-foreground">
                  {t("settings.connectorBundle.commandHint")}
                </p>
              </div>
            ),
          },
          {
            term: t("settings.connectorBundle.network"),
            value: (
              <div className="flex flex-col gap-1">
                <List items={card.network} none={t("settings.connectorBundle.noNetwork")} />
                {card.network.length > 0 ? (
                  <p className="text-callout text-muted-foreground">
                    {t("settings.connectorBundle.networkHint")}
                  </p>
                ) : null}
              </div>
            ),
          },
          {
            term: t("settings.connectorBundle.env"),
            value: (
              <div className="flex flex-col gap-1">
                <List items={card.env} none={t("settings.connectorBundle.noEnv")} />
                {card.env.length > 0 ? (
                  <p className="text-callout text-muted-foreground">
                    {t("settings.connectorBundle.envHint")}
                  </p>
                ) : null}
              </div>
            ),
          },
          {
            term: t("settings.connectorBundle.secrets"),
            value: (
              <div className="flex flex-col gap-1">
                {card.secrets.length === 0 ? (
                  <span className="text-muted-foreground">
                    {t("settings.connectorBundle.noSecrets")}
                  </span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {card.secrets.map((s) => (
                      <li key={s.name}>
                        <code>{show(s.name, 64)}</code>
                        {s.purpose ? <span> · {show(s.purpose, 120)}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {card.secrets.length > 0 ? (
                  <p className="text-callout text-muted-foreground">
                    {t("settings.connectorBundle.secretsHint")}
                  </p>
                ) : null}
              </div>
            ),
          },
        ]}
      />

      <details className="rounded-md border border-gray-6 p-2" open={tools.length <= 8}>
        <summary className="cursor-pointer font-medium">
          {t("settings.connectorBundle.tools")} ·{" "}
          {t("settings.connectorBundle.toolsCount", { n: tools.length })}
        </summary>
        <ul className="mt-2 flex flex-col gap-1" aria-label={t("settings.connectorBundle.tools")}>
          {tools.map((tool) => (
            <li key={tool.name} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{show(tool.name, 128)}</span>
              <StatusChip tone={TIER_TONE[tool.sideEffect]}>
                {t(`settings.mcp.tier.${tool.sideEffect}`)}
              </StatusChip>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-callout text-muted-foreground">
          {t("settings.connectorBundle.toolsHint")}
        </p>
        {check !== undefined && check.undeclared.length > 0 ? (
          <p role="alert" className="mt-1 text-danger-text">
            {t("settings.connectorBundle.toolsUndeclared", {
              names: check.undeclared.map((x) => show(x, 128)).join(", "),
            })}
          </p>
        ) : null}
        {check !== undefined && check.missing.length > 0 ? (
          <p className="mt-1 text-approval-text">
            {t("settings.connectorBundle.toolsMissing", {
              names: check.missing.map((x) => show(x, 128)).join(", "),
            })}
          </p>
        ) : null}
      </details>

      {card.files.length > 0 ? (
        <details className="rounded-md border border-gray-6 p-2">
          <summary className="cursor-pointer font-medium">
            {t("settings.connectorBundle.files", { n: card.files.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {card.files.map((f) => (
              <li key={f.path}>
                <p className="font-medium">
                  {t("settings.connectorBundle.file", { path: show(f.path, 200), bytes: f.bytes })}
                </p>
                {f.text === undefined ? (
                  <p className="text-callout text-muted-foreground">
                    {t("settings.connectorBundle.fileBinary")}
                  </p>
                ) : (
                  <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-gray-3 p-2">
                    {f.text}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {card.update && card.update.diff !== "" ? (
        <details className="rounded-md border border-gray-6 p-2">
          <summary className="cursor-pointer font-medium">
            {t("settings.connectorBundle.diff")}
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-3 p-2">
            {card.update.diff}
          </pre>
        </details>
      ) : null}

      {card.findings.length > 0 ? (
        <section
          className="flex flex-col gap-1"
          aria-label={t("settings.connectorBundle.findings")}
        >
          <h4 className="font-medium">{t("settings.connectorBundle.findings")}</h4>
          <ul className="flex flex-col gap-1">
            {card.findings.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: findings may repeat a rule
              <li key={i} className={f.severity === "high" ? "text-danger-text" : undefined}>
                {t(`settings.connectorBundle.finding.${f.severity}`, {
                  message: show(`${f.message}${f.file ? ` (${f.file})` : ""}`, 300),
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="text-callout text-muted-foreground">
        <summary className="cursor-pointer">{t("settings.mcp.trust.details")}</summary>
        <Facts
          className="mt-2"
          items={[
            { term: t("settings.mcp.trust.id"), value: <code>{show(card.serverId, 64)}</code> },
            {
              term: t("settings.connectorBundle.hash"),
              value: <code className="break-all">{show(card.bundleHash, 80)}</code>,
            },
          ]}
        />
      </details>

      {children}
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {blocked ? t("settings.connectorBundle.close") : t("common.cancel")}
        </Button>
      </div>
    </section>
  );
}
