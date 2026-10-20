import type { ApprovalRequest } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";

/**
 * Binding details shown in full, by kind (UI design §3.3). Everything here comes from the
 * Gateway's `details`, which the Broker built from the exact arguments the binding hash covers.
 */

type Details = Record<string, unknown>;

const str = (v: unknown): string =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0)
    ? "none"
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
        {open ? "Hide" : label}
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
      <Row label="Approval">
        <span className="font-mono text-caption break-all">{approval.id}</span>
      </Row>
      <Row label="Binding">
        <span className="font-mono text-caption break-all">{approval.bindingHash}</span>
      </Row>
    </dl>
  );
}

export function ApprovalDetails({
  approval,
  persona = "The agent",
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
          <Row label="Command">
            {argv ? (
              // One token per argument, quoted when it contains spaces, so ["rm", "-rf foo"]
              // and ["rm", "-rf", "foo"] never look the same.
              <ol
                className="inline-flex flex-wrap gap-1"
                aria-label={`Arguments: ${argv.map((a) => JSON.stringify(a)).join(", ")}`}
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
          <Row label="In">{str(d.cwd)}</Row>
          {env.length > 0 ? <Row label="Env names">{env.join(", ")}</Row> : null}
          {approval.kind === "exec_host" ? (
            <Row label="Runs">
              <span className="text-danger-text">on your Mac, outside the sandbox</span>
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
          <Row label="To">
            {to.join(", ")} <span className="text-muted-foreground">(exact recipient)</span>
          </Row>
          {Array.isArray(d.cc) && d.cc.length > 0 ? <Row label="Cc">{str(d.cc)}</Row> : null}
          <Row label="Subject">{str(d.subject)}</Row>
          {d.bodyPreview !== undefined || d.body !== undefined ? (
            <Row label="Body">
              <Expandable label="View" text={str(d.body ?? d.bodyPreview)} />
            </Row>
          ) : null}
          {Array.isArray(d.attachments) && d.attachments.length > 0 ? (
            <Row label="Attachments">
              {(d.attachments as { name?: string }[]).map((a) => a.name ?? "file").join(", ")}
            </Row>
          ) : null}
          <Row label="Account">{str(d.account)}</Row>
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
          <Row label="Item">{str(d.item ?? d.credential)}</Row>
          <Row label="Bound to">{bound}</Row>
          <Row label="This page">
            {current}
            {bound !== current ? (
              <span className="ml-1 inline-flex items-center gap-1 text-danger-text">
                <TriangleAlert className="size-3.5" aria-hidden="true" /> does not match
              </span>
            ) : null}
          </Row>
          <Row label="Fields">{str(d.fields)}</Row>
          <Row label={`${persona} sees`}>only the placeholder, never the value</Row>
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
          <Row label="Merchant">{str(d.merchant)}</Row>
          <Row label="Amount">
            <span className="font-semibold">{str(d.amount)}</span>
          </Row>
          {items.length > 0 ? (
            <Row label="Items">
              <ul>
                {items.map((li, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: line items are fixed for the card
                  <li key={i}>
                    {li.qty ?? 1} × {li.name ?? "item"} — {li.amount ?? ""}
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
          <Row label="Path">
            <Code>{str(d.path)}</Code>
          </Row>
          {typeof d.diff === "string" ? (
            <Row label="Change">
              <Expandable label="View diff" text={d.diff} />
            </Row>
          ) : null}
          <Rest details={d} shown={["path", "diff"]} />
        </dl>
      );
    case "mcp_tool":
      return (
        <dl>
          <Row label="Tool">
            <Code>{str(d.tool)}</Code>
          </Row>
          <Row label="Server trust">{str(d.trustTier)}</Row>
          <Row label="Arguments">
            <pre className="max-h-40 overflow-auto rounded-md bg-gray-3 p-2 font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(d.argsPreview ?? d.args ?? {}, null, 2)}
            </pre>
          </Row>
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
            <Row label="Target">{approval.target.display ?? approval.target.value}</Row>
          ) : null}
        </dl>
      );
  }
}
