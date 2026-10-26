import type { ReactElement } from "react";
import { formatElapsed } from "../components/steps/LiveDuration.tsx";
import {
  useAutomations,
  useGatewayQuery,
  useStoreState,
  useThreads,
  useUpcoming,
} from "../data/index.ts";
import { useRunsList } from "../data/runs.ts";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { routeLink } from "../overview/overviewLinks.ts";
import { overviewRunHref } from "../overview/recent.ts";
import { useSlots } from "../slots.tsx";
import { runTitle } from "./timeline/RunHeader.tsx";
import { useAgentStatus } from "./useAgentState.ts";

export interface NowNext {
  kind: "working" | "waiting" | "idle" | "paused" | "other";
  text: string;
  /** The step's status line, for a tooltip. */
  detail?: string;
  /** Where the line leads: the run's Timeline, or the Overview's Now & next. */
  href: string;
}

/**
 * The agent sheet's one-line status (agent-overview-2026 §4.1): Working on X · 0:42, Waiting for
 * you · N approvals, a paused state, or Idle · next: {automation} {relative} (`automations.upcoming`,
 * limit 1).
 */
export function useNowNext(fixedNow?: number): NowNext {
  const now = useNow(1000, fixedNow);
  const status = useAgentStatus();
  const live = useRunsList({ status: ["running"] });
  useThreads();
  const threads = useStoreState((s) => s.threads);
  const upcoming = useUpcoming({ limit: 1 });
  const automations = useAutomations();
  const memory = useGatewayQuery("memory.status", {});

  const run = live.runs.find((r) => r.parentRunId == null);
  const next = upcoming.items.find((i) => i.enabled && i.nextRunAt !== null);
  const list = automations.automations;
  const automationsPaused = list.length > 0 && list.every((a) => !a.enabled);

  if (status.state === "offline") return { kind: "other", text: status.snippet, href: "/overview" };
  if (status.needsYou > 0) {
    return {
      kind: "waiting",
      text: t("agent.sheet.now.waiting", { n: status.needsYou }),
      href: "/overview#now",
    };
  }
  if (run) {
    const title = runTitle(run, threads[run.threadId]?.thread.title);
    return {
      kind: "working",
      text: t("agent.sheet.now.working", {
        title,
        elapsed: formatElapsed(Math.max(0, now - Date.parse(run.startedAt))),
      }),
      ...(run.currentStep?.label ? { detail: run.currentStep.label } : {}),
      href: overviewRunHref(run.id),
    };
  }
  if (status.state === "working") {
    return { kind: "working", text: status.snippet, href: "/overview#now" };
  }
  if (memory.data?.paused) {
    return { kind: "paused", text: t("agent.sheet.now.memoryPaused"), href: "/overview#now" };
  }
  if (automationsPaused) {
    return { kind: "paused", text: t("agent.sheet.now.automationsPaused"), href: "/overview#now" };
  }
  if (next?.nextRunAt) {
    return {
      kind: "idle",
      text: t("agent.sheet.now.idleNext", {
        title: next.title,
        when: formatRelative(next.nextRunAt, now),
      }),
      href: "/overview#now",
    };
  }
  return { kind: "idle", text: t("agent.sheet.now.idle"), href: "/overview#now" };
}

/** The line as a link: it opens the run's Timeline or the Overview's Now & next. */
export function NowNextLine({ now }: { now?: number }): ReactElement {
  const line = useNowNext(now);
  const navigate = useSlots().navigate;
  const link = routeLink(line.href, navigate);
  return (
    <a
      href={link.href}
      onClick={link.onClick}
      title={line.detail}
      data-testid="agent-now-next"
      data-kind={line.kind}
      className="block min-w-0 truncate rounded-sm text-callout text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
    >
      {line.text}
    </a>
  );
}
