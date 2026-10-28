import type { ApprovalRequest } from "@psyche/protocol";
import type { ReactElement, ReactNode } from "react";
import { t } from "../i18n/core.ts";
import { DiffBlock } from "./DiffBlock.tsx";

/**
 * The card for a connector Psyche wrote (or suggests): every file in full, the exact command,
 * the network it asks for, its tools and, on an update, the diff against the approved code. The
 * Gateway sends the lines already sanitized, one array entry per line.
 */

type Details = Record<string, unknown>;
interface FileView {
  path: string;
  bytes: number;
  provided?: boolean;
  lines: string[];
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-0.5 text-body">
      <dt className="text-callout leading-[18px] text-label-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-label-primary">{children}</dd>
    </div>
  );
}

function filesOf(v: unknown): FileView[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f) => {
    const o = f as Partial<FileView> | null;
    return o !== null && typeof o === "object" && typeof o.path === "string"
      ? [
          {
            path: o.path,
            bytes: typeof o.bytes === "number" ? o.bytes : 0,
            ...(o.provided === true ? { provided: true } : {}),
            lines: list(o.lines),
          },
        ]
      : [];
  });
}

/** The files (each opens to its full text) and the diff, shared by the approval card and Settings. */
export function SelfConnectorCode({
  files,
  diff,
  previousVersion,
}: {
  files: readonly FileView[];
  diff?: readonly string[];
  previousVersion?: string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2" data-testid="self-connector-code">
      {diff !== undefined && diff.length > 0 ? (
        <div data-testid="self-connector-diff">
          <p className="text-callout text-label-secondary">
            {t("blocks.details.connector.diff", { version: previousVersion ?? "" })}
          </p>
          <DiffBlock diff={diff.join("\n")} className="mt-1 max-h-80 overflow-auto" />
        </div>
      ) : null}
      {files.map((f) => (
        <details key={f.path} className="rounded-md border border-separator p-2">
          <summary className="cursor-default text-mono">
            {t("blocks.details.connector.file", { path: f.path, bytes: f.bytes })}
            {f.provided ? ` · ${t("blocks.details.connector.provided")}` : ""}
          </summary>
          {f.provided ? null : (
            <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-fill-quaternary p-2 text-mono whitespace-pre-wrap">
              {f.lines.join("\n")}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

/** `skill_install` card with `details.kind: "mcp_server"` and `madeBy: "psyche"`. */
export function SelfConnectorDetails({
  approval,
  persona,
}: {
  approval: ApprovalRequest;
  persona: string;
}): ReactElement {
  const d = approval.details as Details;
  const files = filesOf(d.files);
  const network = list(d.requestedNetwork);
  return (
    <dl>
      <Row label={t("blocks.details.connector.runtime")}>
        {t("blocks.details.connector.runtimeValue", { persona, version: String(d.version ?? "") })}
      </Row>
      <Row label={t("blocks.details.connector.command")}>
        <code className="rounded-xs bg-fill-tertiary px-1 text-mono">
          {String(d.command ?? "")}
        </code>
      </Row>
      <Row label={t("blocks.details.connector.network")}>
        {network.length > 0 ? network.join(", ") : t("blocks.details.connector.networkNone")}
      </Row>
      <Row label={t("blocks.details.connector.tools")}>
        {list(d.tools).join(", ") || t("blocks.details.none")}
      </Row>
      <Row label={t("blocks.details.connector.files", { n: files.length })}>
        <SelfConnectorCode
          files={files}
          diff={list(d.diff)}
          {...(typeof d.previousVersion === "string" ? { previousVersion: d.previousVersion } : {})}
        />
      </Row>
    </dl>
  );
}

export type { FileView as SelfConnectorFileView };
export { filesOf as selfConnectorFiles, list as selfConnectorLines };
