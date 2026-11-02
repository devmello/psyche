import type { WidgetBind } from "@psyche/protocol";
import { createContext, type ReactElement, useContext } from "react";
import { useAutomations, useStoreState, useTask, useToolCall } from "../data/index.ts";
import { useSpecialistJob } from "../data/specialists.ts";
import { t } from "../i18n/core.ts";
import { formatDate, formatTime } from "../lib/format.ts";
import { foldResearch, type ResearchStepId } from "../research/model.ts";
import { RenderNode } from "./nodes.tsx";

/**
 * Live bindings (generative-ui-2026 §5.4): a node with `bind: {source, id, field}` is drawn from
 * an entity the app already tracks, so a progress widget for a background task keeps moving after
 * the run that drew it has ended, with no model tokens and no stored patches. The renderer
 * subscribes to the same store slices the rest of the app uses (`task.updated`, `tool_call.updated`,
 * `research.progress`, `automation.updated`, `specialist.*`); nothing here talks to the model.
 *
 * Each source is its own component so every hook is called unconditionally. An entity of another
 * chat, a deleted one, or one that never loads renders "Unavailable": ids cannot be probed.
 */

type N = Record<string, unknown>;

/** The chat the widget lives in; bound entities of any other chat are unavailable. */
export const WidgetChatContext = createContext<string | null>(null);

/** What a source yields for a field: props merged over the node, or null when unavailable. */
type Props = N | null | "loading";

const RESEARCH_STEPS: readonly ResearchStepId[] = [
  "scope",
  "plan",
  "read",
  "extract",
  "crosscheck",
  "synthesize",
  "save",
];

const tone = (status: string): string =>
  status === "done" || status === "ok" ? "success" : status === "failed" ? "danger" : "neutral";

/** One status as props for a `status` node, or `{text}` for a `text` node. */
function statusProps(node: N, status: string): N {
  const label = t("widgets.bound.status", { status });
  return node.type === "status" ? { label, tone: tone(status) } : { text: label };
}

function done(items: ReadonlyArray<{ status: string }>): { value: number; max: number } {
  return { value: items.filter((i) => i.status === "completed").length, max: items.length };
}

function TaskBound({ node, bind, depth }: P): ReactElement {
  const chat = useContext(WidgetChatContext);
  const { task, loading } = useTask(bind.id);
  let props: Props = "loading";
  if (task === null || task === undefined) {
    if (!loading) props = null;
  } else if (task.threadId !== chat && task.specialist?.parentThreadId !== chat) {
    props = null;
  } else if (bind.field === "status") props = statusProps(node, task.status);
  else if (bind.field === "title") props = { text: task.title };
  else if (bind.field === "summary") props = { text: task.summary ?? "" };
  else if (bind.field === "steps") {
    props = {
      items: task.checklist.map((c, i) => ({
        id: `s${i}`,
        label: c.text,
        state: c.status === "completed" ? "done" : c.status === "in_progress" ? "active" : "todo",
      })),
    };
  } else if (bind.field === "progress") {
    const d = done(task.checklist);
    const finished = task.status === "done";
    props =
      d.max === 0
        ? finished
          ? { value: 1, max: 1, indeterminate: false }
          : { indeterminate: task.status === "running" || task.status === "queued" }
        : {
            value: finished ? d.max : d.value,
            max: d.max,
            indeterminate: false,
            tone: task.status === "failed" ? "danger" : "neutral",
          };
  }
  return <Resolved node={node} props={props} depth={depth} />;
}

function ToolCallBound({ node, bind, depth }: P): ReactElement {
  const call = useToolCall(bind.id);
  return (
    <Resolved
      node={node}
      props={call === null ? null : statusProps(node, call.status)}
      depth={depth}
    />
  );
}

function ResearchBound({ node, bind, depth }: P): ReactElement {
  const events = useStoreState((s) => s.research[bind.id]);
  const call = useToolCall(bind.id);
  let props: Props = call === null && events === undefined ? null : "loading";
  if (events !== undefined || call !== null) {
    const v = foldResearch(events ?? []);
    const status =
      v.status === "running" && call && call.status !== "running" && call.status !== "pending"
        ? "stopped"
        : v.status;
    if (bind.field === "status")
      props = statusProps(node, status === "stopped" ? "cancelled" : status);
    else if (bind.field === "claims") {
      props =
        node.type === "stat"
          ? { value: v.claims }
          : { text: t("widgets.bound.claims", { count: v.claims }) };
    } else if (bind.field === "sources") {
      const n = v.sources.length;
      props =
        node.type === "stat" ? { value: n } : { text: t("widgets.bound.sources", { count: n }) };
    } else if (bind.field === "progress") {
      const at = v.step === null ? 0 : RESEARCH_STEPS.indexOf(v.step) + 1;
      props = {
        value: v.status === "done" ? RESEARCH_STEPS.length : at,
        max: RESEARCH_STEPS.length,
      };
    }
  }
  return <Resolved node={node} props={props} depth={depth} />;
}

function AutomationBound({ node, bind, depth }: P): ReactElement {
  const { automations, loading } = useAutomations();
  const a = automations.find((x) => x.id === bind.id);
  let props: Props = "loading";
  if (a === undefined) {
    if (!loading) props = null;
  } else {
    const at = (iso: string | null | undefined, none: string) =>
      iso ? `${formatDate(iso)} ${formatTime(iso)}` : none;
    const text = (s: string) => (node.type === "stat" ? { value: s } : { text: s });
    if (bind.field === "status") {
      props = statusProps(
        node,
        a.lastStatus && a.enabled ? a.lastStatus : a.enabled ? "enabled" : "disabled",
      );
    } else if (bind.field === "nextRun") props = text(at(a.nextRunAt, t("widgets.bound.noNext")));
    else if (bind.field === "lastRun") props = text(at(a.lastRunAt, t("widgets.bound.never")));
  }
  return <Resolved node={node} props={props} depth={depth} />;
}

function JobBound({ node, bind, depth }: P): ReactElement {
  const chat = useContext(WidgetChatContext);
  const { job, loading } = useSpecialistJob(bind.id);
  let props: Props = "loading";
  if (job === null) {
    if (!loading) props = null;
  } else if (job.parentThreadId !== chat && job.threadId !== chat) props = null;
  else if (bind.field === "status") props = statusProps(node, job.status);
  else if (bind.field === "lastStep") props = { text: job.lastStep ?? "" };
  return <Resolved node={node} props={props} depth={depth} />;
}

interface P {
  node: N;
  bind: WidgetBind;
  depth: number;
}

/** Merges bound props over the node; `loading` keeps the static node, `null` says Unavailable. */
function Resolved({ node, props, depth }: { node: N; props: Props; depth: number }): ReactElement {
  if (props === null) {
    return (
      <span className="text-callout text-label-secondary" data-testid="widget-unavailable">
        {typeof node.label === "string" && node.label ? `${node.label}: ` : ""}
        {t("widgets.node.unavailable")}
      </span>
    );
  }
  const { bind: _bind, ...rest } = node;
  const merged = props === "loading" ? rest : { ...rest, ...props };
  const status = node.type === "status" || node.type === "text";
  const el = <RenderNode node={merged} depth={depth} />;
  // A status that changes is announced politely (§10.1); everything else stays silent.
  return status ? <span role="status">{el}</span> : el;
}

export function BoundNode({ node, depth }: { node: N; depth: number }): ReactElement | null {
  const bind = node.bind as WidgetBind;
  switch (bind.source) {
    case "task":
      return <TaskBound node={node} bind={bind} depth={depth} />;
    case "tool_call":
      return <ToolCallBound node={node} bind={bind} depth={depth} />;
    case "research":
      return <ResearchBound node={node} bind={bind} depth={depth} />;
    case "automation":
      return <AutomationBound node={node} bind={bind} depth={depth} />;
    case "job":
      return <JobBound node={node} bind={bind} depth={depth} />;
    default:
      return <Resolved node={node} props={null} depth={depth} />;
  }
}
