import type { ApprovalRequest } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { t } from "../i18n/core.ts";
import { DiffBlock } from "./DiffBlock.tsx";

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
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-0.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function Code({ children }: { children: ReactNode }): ReactElement {
  return <code className="rounded bg-gray-3 px-1 font-mono text-[13px]">{children}</code>;
}

/** A diff behind "View diff", in the kit's code block (Shiki `diff`). */
function ExpandableDiff({ diff }: { diff: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="text-accent-11 hover:underline"
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
        className="text-accent-11 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? t("blocks.common.hide") : label}
      </button>
      {open ? (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-gray-3 p-2 font-mono text-xs whitespace-pre-wrap">
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
        .filter(([k, v]) => !shown.includes(k) && k !== "reason" && !isLevel2Key(k, v))
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
            <span className="font-mono text-caption break-all">{str(v)}</span>
          </Row>
        ))}
      <Row label={t("blocks.details.approval")}>
        <span className="font-mono text-caption break-all">{approval.id}</span>
      </Row>
      <Row label={t("blocks.details.binding")}>
        <span className="font-mono text-caption break-all">{approval.bindingHash}</span>
      </Row>
    </dl>
  );
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
            <Row label={t("blocks.details.runs")}>
              <span className="text-danger-text">{t("blocks.details.runsOnHost")}</span>
            </Row>
          ) : null}
          <Rest details={d} shown={["command", "cwd", "argv", "env"]} />
        </dl>
      );
    }
    case "send_email": {
      const to = Array.isArray(d.to) ? (d.to as string[]) : [str(d.to)];
      return (
        <dl>
          <Row label={t("blocks.details.to")}>
            {to.join(", ")}{" "}
            <span className="text-muted-foreground">{t("blocks.details.exactRecipient")}</span>
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
            <span className="font-mono text-caption break-all">{str(d.commit)}</span>
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
            <pre className="max-h-40 overflow-auto rounded-md bg-gray-3 p-2 font-mono text-xs whitespace-pre-wrap">
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
    default:
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
}
