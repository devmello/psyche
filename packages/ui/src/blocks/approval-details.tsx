import type { ApprovalRequest } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { t } from "../i18n/core.ts";
import { DiffBlock } from "./DiffBlock.tsx";
import { SelfConnectorCode, SelfConnectorDetails } from "./SelfConnectorDetails.tsx";

/**
 * Binding details shown in full, by kind (UI design §3.3). Everything here comes from the
 * Gateway's `details`, which the Broker built from the exact arguments the binding hash covers.
 */

type Details = Record<string, unknown>;

const str = (v: unknown): string =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0)
    ? t("blocks.details.none")
    : v === ""
      ? "—"
      : typeof v === "string"
        ? v
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : Array.isArray(v) && v.every((x) => typeof x === "string")
            ? v.join(", ")
            : JSON.stringify(v);

/** `accountDisplay` → "Account display", `toolsListHash` → "Tools list hash". */
function humanize(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-0.5 text-body">
      <dt className="text-callout leading-[18px] text-label-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-label-primary">{children}</dd>
    </div>
  );
}

function Code({ children }: { children: ReactNode }): ReactElement {
  return <code className="rounded-xs bg-fill-tertiary px-1 text-mono">{children}</code>;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * A connector or skill the agent asks to add (`install_capability`): where it comes from, whether
 * it is official, the exact command or address, the network, and what the agent wants it for.
 * Registry text is third-party data, shown as plain text.
 */
function CapabilityInstallDetails({ d }: { d: Details }): ReactElement {
  const verified = d.verified === true;
  const network = strings(d.network);
  const permissions = strings(d.permissions);
  return (
    <dl>
      <Row
        label={t(
          d.capability === "skill"
            ? "capabilities.card.kind.skill"
            : "capabilities.card.kind.connector",
        )}
      >
        <span className="font-medium">{str(d.name)}</span>
      </Row>
      <Row label={t("capabilities.card.source")}>{str(d.source)}</Row>
      <Row label={t("capabilities.card.trust")}>
        <span className={verified ? "text-label-primary" : "font-medium text-approval-text"}>
          {verified ? t("capabilities.badge.official") : t("capabilities.badge.unverified")}
        </span>
      </Row>
      {typeof d.command === "string" ? (
        <Row label={t("capabilities.card.command")}>
          <Code>{d.command}</Code>
        </Row>
      ) : null}
      {typeof d.url === "string" ? (
        <Row label={t("capabilities.card.url")}>
          <Code>{d.url}</Code>
        </Row>
      ) : null}
      <Row label={t("capabilities.card.network")}>
        {network.length > 0 ? network.join(", ") : str(null)}
      </Row>
      <Row label={t("capabilities.card.permissions")}>
        {permissions.length > 0 ? (
          <ul className="list-disc ps-4">
            {permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          str(null)
        )}
      </Row>
      <Row label={t("capabilities.card.reason")}>{str(d.reason)}</Row>
      {typeof d.summary === "string" && d.summary !== "" ? (
        <Row label={t("capabilities.card.summary")}>{d.summary}</Row>
      ) : null}
      {typeof d.warning === "string" && d.warning !== "" ? (
        <div
          role="alert"
          className="mt-1 flex gap-2 rounded-md border border-approval-border px-2 py-1.5 text-callout text-approval-text"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>{t("capabilities.card.warning")}</strong> {d.warning}
          </span>
        </div>
      ) : null}
      {typeof d.tainted === "string" && d.tainted !== "" ? (
        <div
          role="alert"
          className="mt-1 flex gap-2 rounded-md border border-approval-border px-2 py-1.5 text-callout text-approval-text"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>{t("capabilities.card.tainted")}</strong> {d.tainted}
          </span>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * A script the agent wrote and asks to run once (`run_script`): the whole code, what it is for,
 * its input, and the network it may reach. Nothing runs before the owner approves.
 */
function ScriptRunDetails({ d }: { d: Details }): ReactElement {
  const network = strings(d.network);
  const permissions = strings(d.permissions);
  const files = (Array.isArray(d.files) ? d.files : []).flatMap((f) => {
    const o = f as { path?: unknown; bytes?: unknown; lines?: unknown } | null;
    return o !== null && typeof o === "object" && typeof o.path === "string"
      ? [
          {
            path: o.path,
            bytes: typeof o.bytes === "number" ? o.bytes : 0,
            lines: strings(o.lines),
          },
        ]
      : [];
  });
  return (
    <dl>
      <Row label={t("capabilities.script.purpose")}>{str(d.purpose)}</Row>
      <Row label={t("capabilities.script.language")}>
        <Code>{str(d.language)}</Code>
      </Row>
      <Row label={t("capabilities.script.code")}>
        <SelfConnectorCode files={files} />
      </Row>
      <Row label={t("capabilities.script.input")}>
        <Code>{str(d.input)}</Code>
      </Row>
      <Row label={t("capabilities.card.network")}>
        {network.length > 0 ? network.join(", ") : str(null)}
      </Row>
      {permissions.length > 0 ? (
        <Row label={t("capabilities.card.permissions")}>
          <ul className="list-disc ps-4">
            {permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Row>
      ) : null}
      {typeof d.tainted === "string" && d.tainted !== "" ? (
        <div
          role="alert"
          className="mt-1 flex gap-2 rounded-md border border-approval-border px-2 py-1.5 text-callout text-approval-text"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>{t("capabilities.card.tainted")}</strong> {d.tainted}
          </span>
        </div>
      ) : null}
    </dl>
  );
}

/** A diff behind "View diff", in the kit's code block (Shiki `diff`). */
function ExpandableDiff({ diff }: { diff: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="cursor-default text-accent-11 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? t("blocks.common.hide") : t("blocks.common.viewDiff")}
      </button>
      {open ? <DiffBlock diff={diff} className="mt-1 max-h-80 overflow-auto" /> : null}
    </>
  );
}

function Expandable({ label, text }: { label: string; text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="cursor-default text-accent-11 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? t("blocks.common.hide") : label}
      </button>
      {open ? (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-fill-quaternary p-2 text-mono whitespace-pre-wrap">
          {text}
        </pre>
      ) : null}
    </>
  );
}

/**
 * Disclosure level 2 (UI design §1.2 principle 3): ids, hashes, digests, selectors and resolved
 * paths. They bind the card but are not what a person reads to decide, so they sit in the card's
 * "Details" disclosure rather than among the rows.
 */
export function isLevel2Key(key: string, value: unknown): boolean {
  if (/(^id$|Id$|Ids$|^hash$|Hash$|Digest$|Selector$|Resolved$|Ref$|^grantKey$|Key$)/.test(key))
    return true;
  return typeof value === "string" && /^(sha256:)?[0-9a-f]{32,}$/i.test(value);
}

function Rest({ details, shown }: { details: Details; shown: readonly string[] }): ReactElement {
  return (
    <>
      {Object.entries(details)
        // `reason` is the Broker's explanation, shown as "Why asked" by the card.
        .filter(
          ([k, v]) =>
            !shown.includes(k) && k !== "reason" && k !== "taintSources" && !isLevel2Key(k, v),
        )
        .map(([k, v]) => (
          <Row key={k} label={humanize(k)}>
            {str(v)}
          </Row>
        ))}
    </>
  );
}

/** The level-2 entries of `details` in full, for the card's "Details" disclosure. */
export function ApprovalIds({ approval }: { approval: ApprovalRequest }): ReactElement {
  const d = approval.details as Details;
  return (
    <dl>
      {Object.entries(d)
        .filter(([k, v]) => k !== "reason" && isLevel2Key(k, v))
        .map(([k, v]) => (
          <Row key={k} label={humanize(k)}>
            <span className="font-mono text-callout break-all">{str(v)}</span>
          </Row>
        ))}
      {Array.isArray(d.taintSources) && d.taintSources.length > 0 ? (
        <Row label={t("blocks.approval.taintDetails")}>
          <span className="font-mono text-callout break-all">{str(d.taintSources)}</span>
        </Row>
      ) : null}
      <Row label={t("blocks.details.approval")}>
        <span className="font-mono text-callout break-all">{approval.id}</span>
      </Row>
      <Row label={t("blocks.details.binding")}>
        <span className="font-mono text-callout break-all">{approval.bindingHash}</span>
      </Row>
    </dl>
  );
}

/** One line for a `MissingPermission` (`permission_request` cards). */
export function needText(need: unknown): string {
  const n = (typeof need === "object" && need !== null ? need : {}) as Record<string, unknown>;
  const kind = typeof n.need === "string" ? n.need : "";
  const connector = String(n.connector ?? "").replace(/^apple[.-]/, "Apple ");
  switch (kind) {
    case "capability":
    case "sandbox":
      return t(`blocks.permission.need.${kind}`);
    case "connector_action":
      return t("blocks.permission.need.connector_action", { connector, group: str(n.group) });
    case "connector":
    case "macos_access":
      return t(`blocks.permission.need.${kind}`, { connector });
    case "folder":
      return t("blocks.permission.need.folder", { path: str(n.path) });
    default:
      return str(need);
  }
}

export function ApprovalDetails({
  approval,
  persona = t("blocks.common.theAgent"),
}: {
  approval: ApprovalRequest;
  persona?: string;
}): ReactElement {
  const d = approval.details as Details;
  switch (approval.kind) {
    case "skill_install": {
      // Psyche's own connector: every file, the command, the network and the diff.
      if (d.kind === "mcp_server" && d.madeBy === "psyche") {
        return <SelfConnectorDetails approval={approval} persona={persona} />;
      }
      if (d.kind === "capability_install") return <CapabilityInstallDetails d={d} />;
      if (d.kind === "script_run") return <ScriptRunDetails d={d} />;
      // Psyche writing its own skill: the whole text and, on an update, the diff to read first.
      if (d.madeBy !== "agent") return <GenericDetails approval={approval} d={d} />;
      return (
        <dl>
          <Row label={t("blocks.details.skillAction")}>
            {t("blocks.details.skillActionValue", { action: str(d.action), persona })}
          </Row>
          <Row label={t("blocks.details.name")}>
            <Code>{str(d.name)}</Code>
          </Row>
          {typeof d.text === "string" ? (
            <Row label={t("blocks.details.skillText")}>
              <Expandable label={t("blocks.details.skillTextView")} text={d.text} />
            </Row>
          ) : null}
          {typeof d.diff === "string" ? (
            <Row label={t("blocks.details.change")}>
              <ExpandableDiff diff={d.diff} />
            </Row>
          ) : null}
          {Array.isArray(d.files) ? (
            <Row label={t("blocks.details.files")}>{str(d.files)}</Row>
          ) : null}
          <Rest
            details={d}
            shown={[
              "action",
              "madeBy",
              "name",
              "text",
              "diff",
              "files",
              "scope",
              "source",
              "fromHash",
            ]}
          />
        </dl>
      );
    }
    case "exec":
    case "exec_host": {
      const argv = Array.isArray(d.argv) ? (d.argv as unknown[]).map(String) : null;
      const env = Array.isArray(d.env) ? (d.env as unknown[]).map(String) : [];
      return (
        <dl>
          <Row label={t("blocks.details.command")}>
            {argv ? (
              // One token per argument, quoted when it contains spaces, so ["rm", "-rf foo"]
              // and ["rm", "-rf", "foo"] never look the same.
              <ol
                className="inline-flex flex-wrap gap-1"
                aria-label={t("blocks.details.argumentsList", {
                  args: argv.map((a) => JSON.stringify(a)).join(", "),
                })}
              >
                {argv.map((a, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: argv order is the binding
                  <li key={i}>
                    <Code>{/[\s"'\\]/.test(a) || a === "" ? JSON.stringify(a) : a}</Code>
                  </li>
                ))}
              </ol>
            ) : (
              <Code>{str(d.command)}</Code>
            )}
          </Row>
          <Row label={t("blocks.details.in")}>{str(d.cwd)}</Row>
          {env.length > 0 ? <Row label={t("blocks.details.envNames")}>{env.join(", ")}</Row> : null}
          {approval.kind === "exec_host" ? (
            <>
              {/* The program that runs, after PATH and symlinks (security §5.4); its hash binds. */}
              {d.executable !== undefined ? (
                <Row label={t("blocks.details.executable")}>
                  <Code>{str(d.executable)}</Code>
                </Row>
              ) : null}
              <Row label={t("blocks.details.network")}>
                {Array.isArray(d.allowedDomains) && d.allowedDomains.length > 0
                  ? (d.allowedDomains as unknown[]).map(String).join(", ")
                  : t("blocks.details.networkNone")}
              </Row>
              <Row label={t("blocks.details.runs")}>
                {d.sandbox === "srt" ? (
                  t("blocks.details.runsSandboxed")
                ) : d.sandbox === "missing" ? (
                  <span className="text-danger-text">
                    {t("blocks.details.runsNoSandbox", { reason: str(d.sandboxMissingReason) })}
                  </span>
                ) : (
                  <span className="text-danger-text">{t("blocks.details.runsOnHost")}</span>
                )}
              </Row>
            </>
          ) : null}
          <Rest
            details={d}
            shown={[
              "command",
              "cwd",
              "argv",
              "env",
              "executable",
              "allowedDomains",
              "sandbox",
              "sandboxMissingReason",
              "unsandboxedWord",
              "unsandboxed",
            ]}
          />
        </dl>
      );
    }
    case "send_email": {
      const to = Array.isArray(d.to) ? (d.to as string[]) : [str(d.to)];
      return (
        <dl>
          <Row label={t("blocks.details.to")}>
            {to.join(", ")}{" "}
            <span className="text-label-secondary">{t("blocks.details.exactRecipient")}</span>
          </Row>
          {Array.isArray(d.cc) && d.cc.length > 0 ? (
            <Row label={t("blocks.details.cc")}>{str(d.cc)}</Row>
          ) : null}
          <Row label={t("blocks.details.subject")}>{str(d.subject)}</Row>
          {d.bodyPreview !== undefined || d.body !== undefined ? (
            <Row label={t("blocks.details.body")}>
              <Expandable label={t("blocks.details.view")} text={str(d.body ?? d.bodyPreview)} />
            </Row>
          ) : null}
          {Array.isArray(d.attachments) && d.attachments.length > 0 ? (
            <Row label={t("blocks.details.attachments")}>
              {(d.attachments as { name?: string }[])
                .map((a) => a.name ?? t("blocks.details.attachmentDefault"))
                .join(", ")}
            </Row>
          ) : null}
          <Row label={t("blocks.details.account")}>{str(d.account)}</Row>
          <Rest
            details={d}
            shown={["to", "cc", "subject", "body", "bodyPreview", "attachments", "account"]}
          />
        </dl>
      );
    }
    case "credential_fill": {
      const bound = str(d.boundOrigin ?? d.origin);
      const current = str(d.currentOrigin ?? d.origin);
      return (
        <dl>
          <Row label={t("blocks.details.item")}>{str(d.item ?? d.credential)}</Row>
          <Row label={t("blocks.details.boundTo")}>{bound}</Row>
          <Row label={t("blocks.details.thisPage")}>
            {current}
            {bound !== current ? (
              <span className="ms-1 inline-flex items-center gap-1 text-danger-text">
                <TriangleAlert className="size-3.5" aria-hidden="true" />{" "}
                {t("blocks.details.mismatch")}
              </span>
            ) : null}
          </Row>
          <Row label={t("blocks.details.fields")}>{str(d.fields)}</Row>
          <Row label={t("blocks.details.personaSees", { persona })}>
            {t("blocks.details.placeholderOnly")}
          </Row>
          <Rest
            details={d}
            shown={["item", "credential", "boundOrigin", "origin", "currentOrigin", "fields"]}
          />
        </dl>
      );
    }
    case "purchase": {
      const items = Array.isArray(d.lineItems)
        ? (d.lineItems as { name?: string; qty?: number; amount?: string }[])
        : [];
      return (
        <dl>
          <Row label={t("blocks.details.merchant")}>{str(d.merchant)}</Row>
          <Row label={t("blocks.details.amount")}>
            <span className="font-semibold">{str(d.amount)}</span>
          </Row>
          {items.length > 0 ? (
            <Row label={t("blocks.details.items")}>
              <ul>
                {items.map((li, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: line items are fixed for the card
                  <li key={i}>
                    {t("blocks.details.lineItem", {
                      qty: li.qty ?? 1,
                      name: li.name ?? t("blocks.details.lineItemDefault"),
                      amount: li.amount ?? "",
                    })}
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
          <Rest details={d} shown={["merchant", "amount", "lineItems"]} />
        </dl>
      );
    }
    case "file_write":
      return (
        <dl>
          <Row label={t("blocks.details.path")}>
            <Code>{str(d.path)}</Code>
          </Row>
          {Array.isArray(d.files) ? (
            <Row label={t("blocks.details.files")}>{str(d.files)}</Row>
          ) : null}
          {typeof d.diff === "string" ? (
            <Row label={t("blocks.details.change")}>
              <ExpandableDiff diff={d.diff} />
            </Row>
          ) : null}
          <Rest details={d} shown={["path", "diff", "files"]} />
        </dl>
      );
    case "git_write":
      return (
        <dl>
          <Row label={t("blocks.details.repository")}>
            <Code>{str(d.repo)}</Code>
          </Row>
          <Row label={t("blocks.details.operation")}>{str(d.operation)}</Row>
          {d.branch !== undefined ? (
            <Row label={t("blocks.details.branch")}>
              <Code>{str(d.branch)}</Code>
            </Row>
          ) : null}
          {d.message !== undefined ? (
            <Row label={t("blocks.details.message")}>
              <span className="whitespace-pre-wrap">{str(d.message)}</span>
            </Row>
          ) : null}
          {d.paths !== undefined ? (
            <Row label={t("blocks.details.paths")}>{str(d.paths)}</Row>
          ) : null}
          <Rest details={d} shown={["repo", "operation", "branch", "message", "paths"]} />
        </dl>
      );
    case "permission_request":
      // What a denial named as missing (security §3.13); the agent's reason is its own words.
      return (
        <dl>
          <Row label={t("blocks.details.needed")}>{needText(d.need)}</Row>
          <Row label={t("blocks.details.neededWhy")}>{str(d.reason)}</Row>
          <Rest details={d} shown={["need", "reason"]} />
        </dl>
      );
    case "folder_access": {
      // The folder itself is the card's "Folder to share" pick; this is what was asked and why.
      const asked = str(d.requestedPath);
      const same = d.folderStatus === "ok" && d.resolvedPath === d.requestedPath;
      return (
        <dl>
          {same ? null : <Row label={t("blocks.details.requestedFolder")}>{asked}</Row>}
          <Row label={t("blocks.details.folderReason")}>{str(d.reason)}</Row>
          <Row label={t("blocks.details.folderAccess")}>
            {d.access === "rw"
              ? t("blocks.details.folderAccess.rw")
              : t("blocks.details.folderAccess.ro")}
          </Row>
          <Rest
            details={d}
            shown={[
              "requestedPath",
              "reason",
              "access",
              "folderStatus",
              "resolvedPath",
              "blockedReason",
            ]}
          />
        </dl>
      );
    }
    case "message_send":
      // A `messages_send` compose card: the recipient and the text are the card's own editor.
      if (typeof d.compose !== "object" || d.compose === null) {
        return <GenericDetails approval={approval} d={d} />;
      }
      return (
        <dl>
          <Row label={t("blocks.details.account")}>{str(d.account)}</Row>
          <Rest details={d} shown={["channel", "account", "recipient", "compose", "final"]} />
        </dl>
      );
    case "git_push":
      // The binding: remote, its URL, branch and the exact commit, all as rows (a commit hash
      // would otherwise count as a level-2 id and hide in Details).
      return (
        <dl>
          <Row label={t("blocks.details.remote")}>
            <Code>{str(d.remote)}</Code>
          </Row>
          <Row label={t("blocks.details.url")}>
            <Code>{str(d.remoteUrl)}</Code>
          </Row>
          <Row label={t("blocks.details.branch")}>
            <Code>{str(d.branch)}</Code>
          </Row>
          <Row label={t("blocks.details.commit")}>
            <span className="font-mono text-callout break-all">{str(d.commit)}</span>
          </Row>
          <Row label={t("blocks.details.repository")}>
            <Code>{str(d.repo)}</Code>
          </Row>
          <Row label={t("blocks.details.force")}>{t("blocks.details.never")}</Row>
          <Rest details={d} shown={["remote", "remoteUrl", "branch", "commit", "repo"]} />
        </dl>
      );
    case "mcp_tool":
      return (
        <dl>
          <Row label={t("blocks.details.tool")}>
            <Code>{str(d.tool)}</Code>
          </Row>
          <Row label={t("blocks.details.serverTrust")}>{str(d.trustTier)}</Row>
          <Row label={t("blocks.details.arguments")}>
            <pre className="max-h-40 overflow-auto rounded-md bg-fill-quaternary p-2 text-mono whitespace-pre-wrap">
              {JSON.stringify(d.argsPreview ?? d.args ?? {}, null, 2)}
            </pre>
          </Row>
          {/* i18n-ignore: the MCP method whose hash this is */}
          <Row label="tools/list">
            <Code>{str(d.toolsListHash).slice(0, 19)}</Code>
          </Row>
          <Rest details={d} shown={["tool", "trustTier", "args", "argsPreview", "toolsListHash"]} />
        </dl>
      );
    case "batch": {
      // One line per call in plain words (mail-and-meetings-2026 §7.2); the binding is under ⋯.
      const calls = Array.isArray(d.calls) ? (d.calls as unknown[]).map(String) : [];
      return (
        <ol
          aria-label={t("workflows.batch.callsLabel")}
          className="flex flex-col divide-y divide-separator rounded-md bg-fill-quaternary px-3"
        >
          {calls.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the bound list never reorders
            <li key={i} className="py-1.5 text-callout text-label-primary">
              {c}
            </li>
          ))}
        </ol>
      );
    }
    default:
      return <GenericDetails approval={approval} d={d} />;
  }
}

function GenericDetails({ approval, d }: { approval: ApprovalRequest; d: Details }): ReactElement {
  return (
    <dl>
      <Rest details={d} shown={[]} />
      {approval.target ? (
        <Row label={t("blocks.details.target")}>
          {approval.target.display ?? approval.target.value}
        </Row>
      ) : null}
    </dl>
  );
}
