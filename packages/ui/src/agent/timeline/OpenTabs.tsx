import type { BrowserTab } from "@psyche/protocol";
import { type ReactElement, useEffect, useRef } from "react";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { SafeLink } from "../../links/index.ts";

/** The host of a tab's URL, shown beside its title so a lookalike page cannot hide where it is. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The agent browser tabs a run's task has open (`browser.tabs`). Hidden while there are none.
 * Reloads when the run moves (`refreshKey` is the same status, stepCount and endedAt key the
 * helpers use), and never after the first render with an unchanged key.
 */
export function OpenTabs({
  taskId,
  refreshKey,
}: {
  taskId: string | null;
  refreshKey: string;
}): ReactElement | null {
  // A run with no task has no tabs of its own: don't list the whole browser.
  const query = useGatewayQuery(
    "browser.tabs",
    { taskId: taskId ?? undefined },
    { enabled: taskId !== null },
  );
  const { reload } = query;
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    if (taskId !== null) reload();
  }, [refreshKey, taskId, reload]);

  const tabs: readonly BrowserTab[] = taskId === null ? [] : (query.data?.tabs ?? []);
  if (tabs.length === 0) return null;
  return (
    <section
      aria-labelledby="timeline-open-tabs"
      className="flex flex-col gap-1"
      data-testid="timeline-open-tabs"
    >
      <h3 id="timeline-open-tabs" className="text-callout font-medium text-label-secondary">
        {t("agent.timeline.tabs.title")}
      </h3>
      <ul className="flex flex-col gap-1">
        {tabs.map((tab) => {
          const host = hostOf(tab.url);
          return (
            <li key={tab.tabId} className="flex min-w-0 items-baseline gap-2 text-body">
              <SafeLink href={tab.url} className="min-w-0 truncate">
                {tab.title || host}
              </SafeLink>
              <span className="shrink-0 text-callout text-label-secondary">{host}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
