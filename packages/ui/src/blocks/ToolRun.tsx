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

/**
 * A level-1 row: tool icon, the status line, outcome dot and duration in aligned columns. Time,
 * the raw tool name, the receipt id and the I/O are level 2.
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
  const failed = block.status === "failed" || block.status === "blocked";
  // A change the call made, as its receipt recorded it (`code.edit`, a file write).
  const diff = typeof receipt?.payload?.diff === "string" ? receipt.payload.diff : undefined;
  return (
    <li className="flex flex-col gap-1 py-1 text-small">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-gray-11" aria-hidden="true">
          <title>{family}</title>
        </Icon>
        <span className="sr-only">{family}: </span>
        <span className="min-w-0 flex-1 truncate text-foreground">{block.level1}</span>
        <span className="flex w-28 shrink-0 items-center gap-1.5">
          <StatusDot status={block.status} />
          <span
            className={cn(
              "truncate text-callout",
              failed ? "text-danger-text" : "text-muted-foreground",
            )}
          >
            {statusLabel(block.status)}
          </span>
        </span>
        <span className="w-10 shrink-0 text-end text-callout text-muted-foreground tabular-nums">
          {duration(call) ?? ""}
        </span>
      </div>
      {diff !== undefined ? (
        <details className="ms-6">
          <summary className="cursor-pointer text-callout text-accent-11">
            {t("blocks.common.viewDiff")}
          </summary>
          <DiffBlock diff={diff} className="mt-1 max-h-96 overflow-auto" />
        </details>
      ) : null}
      {raw && call ? (
        <div className="ms-6 flex flex-col gap-1 rounded-md bg-gray-2 p-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatTime(call.startedAt)}</span>
            <span className="font-mono text-foreground">{block.tool}</span>
            {receipt?.shortId ? (
              <span className="font-mono text-success-text">{receipt.shortId}</span>
            ) : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5",
                untrusted ? "border-untrusted text-approval-text" : "border-border",
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
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-foreground">
            {JSON.stringify(call.paramsRedacted, null, 2)}
          </pre>
          {call.resultRef ? (
            <span className="font-mono text-xs text-muted-foreground">
              {t("blocks.toolRun.result", { ref: call.resultRef })}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A folded run of tool calls (UI design §3.2). Level 0 shows the summary only, level 1 the rows,
 * level 2 the rows with raw I/O. The summary toggles one more level for this run alone.
 */
export function ToolRun({ items }: { items: readonly ToolCallItem[] }): ReactElement {
  const { level } = useDisclosure();
  const [extra, setExtra] = useState(false);
  const shown = Math.min(2, level + (extra ? 1 : 0));
  const running = items.some((i) => i.block.status === "running");
  const failures = items.filter(
    (i) => i.block.status === "failed" || i.block.status === "uncertain",
  ).length;
  const failed = failures > 0;
  return (
    <div className="my-1" data-disclosure={DISCLOSURE_KEY[shown as 0 | 1 | 2]}>
      <button
        type="button"
        className="inline-flex min-h-6 items-center gap-1.5 rounded-md px-1 py-0.5 text-sm text-gray-11 hover:bg-gray-3"
        aria-expanded={shown > 0}
        onClick={() => setExtra((e) => !e)}
      >
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform duration-120",
            shown > 0 ? "rotate-90" : "rtl:rotate-180",
          )}
          aria-hidden="true"
        />
        <span>{summarizeRun(items)}</span>
        {running ? <StatusDot status="running" /> : failed ? <StatusDot status="failed" /> : null}
        {running ? (
          <span className="sr-only">{t("blocks.toolRun.runningNote")}</span>
        ) : failed ? (
          <span className="sr-only">{t("blocks.toolRun.failedNote", { n: failures })}</span>
        ) : null}
      </button>
      {shown > 0 ? (
        <ul className="ms-1 border-s border-gray-5 ps-2" aria-label={summarizeRun(items)}>
          {items.map((item) => (
            <ToolCallRow key={item.block.toolCallId} item={item} raw={shown === 2} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
