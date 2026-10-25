import type { Receipt, ToolCall, ToolCallStatus } from "@psyche/protocol";
import {
  Bell,
  Brain,
  CalendarDays,
  ChevronRight,
  CreditCard,
  FilePen,
  FileText,
  Globe,
  HardDrive,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageCircleQuestion,
  Plug,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { StatusGlyph, type StatusKind } from "../components/status.tsx";
import { t } from "../i18n/core.ts";
import { formatDuration, formatTime, toolFamily } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { DiffBlock } from "./DiffBlock.tsx";
import { DISCLOSURE_KEY, useDisclosure } from "./disclosure.tsx";
import type { ToolCallBlock } from "./types.ts";

/** One tool call: the block from the message plus the live ToolCall row when it is known. */
export interface ToolCallItem {
  block: ToolCallBlock;
  call?: ToolCall | null;
  receipt?: Receipt | null;
}

const statusLabel = (status: ToolCallStatus): string => t(`blocks.toolRun.status.${status}`);

const STATUS_DOT: Record<ToolCallStatus, string> = {
  pending: "bg-gray-8",
  running: "bg-accent-9 animate-pulse",
  ok: "bg-success",
  failed: "bg-danger",
  uncertain: "bg-approval",
  blocked: "bg-danger",
};

export function StatusDot({ status }: { status: ToolCallStatus }): ReactElement {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_DOT[status])}
      aria-hidden="true"
    />
  );
}

/** "3 actions · browser, calendar" (UI design §3.2). */
export function summarizeRun(items: readonly ToolCallItem[]): string {
  const families = [...new Set(items.map((i) => toolFamily(i.block.tool)))];
  return t("blocks.toolRun.summary", { count: items.length, families: families.join(", ") });
}

function duration(call: ToolCall | null | undefined): string | null {
  if (call?.endedAt == null) return null;
  return formatDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt));
}

/** Lucide icon per tool family (UI design §3.2, §4.6); the family name stays as text for AT. */
const FAMILY_ICON: Record<string, LucideIcon> = {
  browser: Globe,
  gmail: Mail,
  mail: Mail,
  calendar: CalendarDays,
  drive: HardDrive,
  exec: SquareTerminal,
  sandbox: SquareTerminal,
  write: FilePen,
  read: FileText,
  edit: FilePen,
  file: FileText,
  web: Search,
  search: Search,
  memory: Brain,
  remember: Brain,
  forget: Brain,
  payments: CreditCard,
  purchase: CreditCard,
  task: ListChecks,
  subagent: ListChecks,
  harness: ListChecks,
  notify: Bell,
  ask: MessageCircleQuestion,
};

export function toolIcon(tool: string): LucideIcon {
  if (tool.startsWith("mcp__")) return Plug;
  return FAMILY_ICON[toolFamily(tool)] ?? Wrench;
}

/** One status glyph per tool state (redesign-2026 §5.2): spinner, check, cross or clock. */
export function toolGlyph(status: ToolCallStatus): StatusKind {
  switch (status) {
    case "running":
      return "running";
    case "ok":
      return "done";
    case "pending":
      return "waiting";
    default:
      return "failed";
  }
}

/** The glyph a folded run shows: running wins, then a failure, then waiting, then done. */
export function runGlyph(items: readonly ToolCallItem[]): StatusKind {
  const kinds = items.map((i) => toolGlyph(i.block.status));
  if (kinds.includes("running")) return "running";
  if (kinds.includes("failed")) return "failed";
  if (kinds.includes("waiting")) return "waiting";
  return "done";
}

/**
 * An expanded row: the tool's icon, verb + target, the duration in tertiary and one status
 * glyph. Time, the raw tool name, the receipt id and the I/O are level 2.
 */
export function ToolCallRow({
  item,
  raw = false,
}: {
  item: ToolCallItem;
  raw?: boolean;
}): ReactElement {
  const { block, call, receipt } = item;
  const untrusted = call?.provenanceOut === "untrusted";
  const Icon = toolIcon(block.tool);
  const family = toolFamily(block.tool);
  // A change the call made, as its receipt recorded it (`code.edit`, a file write).
  const diff = typeof receipt?.payload?.diff === "string" ? receipt.payload.diff : undefined;
  return (
    <li className="flex flex-col gap-1 py-1 text-body">
      <div className="flex min-h-6 items-center gap-2">
        <Icon className="size-4 shrink-0 text-label-secondary" aria-hidden="true">
          <title>{family}</title>
        </Icon>
        <span className="sr-only">{family}: </span>
        <span className="min-w-0 flex-1 truncate text-label-primary">{block.level1}</span>
        <span className="shrink-0 text-callout text-label-tertiary tabular-nums">
          {duration(call) ?? ""}
        </span>
        <StatusGlyph status={toolGlyph(block.status)} label={statusLabel(block.status)} />
      </div>
      {diff !== undefined ? (
        <details className="ms-6">
          <summary className="cursor-default text-callout text-accent-11">
            {t("blocks.common.viewDiff")}
          </summary>
          <DiffBlock diff={diff} className="mt-1 max-h-96 overflow-auto" />
        </details>
      ) : null}
      {raw && call ? (
        <div className="ms-6 flex flex-col gap-1 rounded-md bg-fill-quaternary p-2">
          <div className="flex flex-wrap items-center gap-2 text-callout text-label-secondary">
            <span className="tabular-nums">{formatTime(call.startedAt)}</span>
            <span className="font-mono text-label-primary">{block.tool}</span>
            {receipt?.shortId ? (
              <span className="font-mono text-success-text">{receipt.shortId}</span>
            ) : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5",
                untrusted ? "border-untrusted text-approval-text" : "border-separator-strong",
              )}
            >
              {untrusted ? <ShieldAlert className="size-3" aria-hidden="true" /> : null}
              {untrusted ? t("blocks.toolRun.untrustedOutput") : t("blocks.toolRun.trustedOutput")}
            </span>
            {call.decision ? (
              <span>
                {t("blocks.toolRun.broker", {
                  decision: call.decision,
                  hasRule: Boolean(call.decisionRule),
                  rule: call.decisionRule ?? "",
                })}
              </span>
            ) : null}
            {call.taintIn ? <span>{t("blocks.toolRun.tainted")}</span> : null}
          </div>
          <pre className="max-h-48 overflow-auto text-mono whitespace-pre-wrap text-label-primary">
            {JSON.stringify(call.paramsRedacted, null, 2)}
          </pre>
          {call.resultRef ? (
            <span className="text-mono text-label-secondary">
              {t("blocks.toolRun.result", { ref: call.resultRef })}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A folded run of tool calls as one row (redesign-2026 §5.2): the leading tool's icon,
 * "3 actions · browser, calendar" and one trailing status glyph. Level 0 shows the row only,
 * level 1 the rows, level 2 the rows with raw I/O; the row toggles one more level for this run.
 */
export function ToolRun({ items }: { items: readonly ToolCallItem[] }): ReactElement {
  const { level } = useDisclosure();
  const [extra, setExtra] = useState(false);
  const shown = Math.min(2, level + (extra ? 1 : 0));
  const glyph = runGlyph(items);
  const failures = items.filter(
    (i) => i.block.status === "failed" || i.block.status === "uncertain",
  ).length;
  const Lead = toolIcon(items[0]?.block.tool ?? "");
  return (
    <div className="my-1.5" data-disclosure={DISCLOSURE_KEY[shown as 0 | 1 | 2]}>
      <button
        type="button"
        className="-ms-1 inline-flex min-h-7 max-w-full cursor-default items-center gap-2 rounded-sm px-1 text-body text-label-secondary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={shown > 0}
        onClick={() => setExtra((e) => !e)}
      >
        <Lead className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{summarizeRun(items)}</span>
        <StatusGlyph status={glyph} />
        {glyph === "running" ? (
          <span className="sr-only">{t("blocks.toolRun.runningNote")}</span>
        ) : failures > 0 ? (
          <span className="sr-only">{t("blocks.toolRun.failedNote", { n: failures })}</span>
        ) : null}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-label-tertiary transition-transform duration-(--spring-snappy-duration) ease-(--spring-snappy) reduced:duration-0",
            shown > 0 ? "rotate-90" : "rtl:rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {shown > 0 ? (
        <ul className="ms-1.5 ps-5" aria-label={summarizeRun(items)}>
          {items.map((item) => (
            <ToolCallRow key={item.block.toolCallId} item={item} raw={shown === 2} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
