import { isHostHelperKind } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";

/** Home's two quiet notes: facts the trust migration moved to review, and a paused helper. */

export const MOVED_FACTS_KEY = "psyche.home.movedFactsDismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(MOVED_FACTS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One line, once: the facts the 2026-11 trust migration moved to review (learned from other
 * people's messages) are waiting. "Review" opens the queue, where "Confirm all" takes them in one
 * go; "Dismiss" hides the line for good. It disappears on its own when none are left, and an
 * older Gateway (no count) or a fresh install (nothing moved) never shows it.
 */
export function MovedFactsNote({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}): ReactElement | null {
  const [dismissed, setDismissed] = useState(readDismissed);
  const q = useGatewayQuery("memory.review.list", { state: ["pending"], limit: 1 });
  const n = q.data?.counts.movedPending ?? 0;
  if (dismissed || n === 0) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(MOVED_FACTS_KEY, "1");
    } catch {
      // Blocked storage: it shows again next launch, which is harmless.
    }
  };
  return (
    <div
      data-testid="home-moved-facts"
      className="flex max-w-prose flex-wrap items-center gap-x-3 gap-y-1 text-body text-label-secondary"
    >
      <p>{t("home.movedFacts", { n })}</p>
      <span className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => onNavigate("/memory/review")}>
          {t("home.movedFacts.review")}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t("home.movedFacts.dismiss")}
        </Button>
      </span>
    </div>
  );
}

/**
 * The helper quits with Psyche, and Mail and Messages are read through it, so they pause while it
 * is offline and the Gateway keeps running. Drawn only when the owner switched either source on,
 * a Host helper is known and none is online. "Open Devices" is where it is restarted.
 */
export function HelperPausedLine(): ReactElement | null {
  const { openSettings } = useSlots();
  const nodes = useGatewayQuery("nodes.list", {});
  const sources = useGatewayQuery("search.sources", {});
  const wanted = sources.data?.sources.some(
    (s) => (s.id === "mail" || s.id === "messages") && s.enabled,
  );
  const helpers = nodes.data?.nodes.filter((x) => isHostHelperKind(x.kind)) ?? [];
  if (wanted !== true || helpers.length === 0 || helpers.some((x) => x.status === "online")) {
    return null;
  }
  return (
    <div
      data-testid="home-helper-paused"
      className="flex max-w-prose flex-wrap items-center gap-x-3 gap-y-1 text-body text-label-secondary"
    >
      <p>{t("home.helperPaused")}</p>
      {openSettings ? (
        <Button size="sm" variant="ghost" onClick={() => openSettings("devices")}>
          {t("home.helperPaused.open")}
        </Button>
      ) : null}
    </div>
  );
}
