import type { NudgeAction } from "@psyche/protocol";
import type { ReactElement } from "react";
import { usePrefillComposer } from "../chat/prefill.ts";
import { GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { NudgeActions } from "./NudgeActions.tsx";

/** Under a nudge's Feed card: the actions for the nudge the post points at (`refs.nudgeId`). */
export function FeedNudgeActions({ nudgeId }: { nudgeId: string }): ReactElement | null {
  const call = useCall();
  const list = useGatewayQuery("nudges.list", {});
  const prefill = usePrefillComposer();
  if (list.loading && list.data === undefined) return null;
  const item = list.data?.items.find((i) => i.id === nudgeId);
  return (
    <NudgeActions
      // A fresh state per nudge, so one card's result never shows on another.
      key={nudgeId}
      item={item}
      {...(prefill ? { onDraft: prefill } : {})}
      onAct={(action: NudgeAction) =>
        call("nudges.act", { id: nudgeId, action }).finally(() => list.reload())
      }
    />
  );
}

/** The person page's "Keep in touch" row: the current nudge, or the mute switch if muted. */
export function PersonNudgeRow({
  entityId,
  name,
}: {
  entityId: string;
  name: string;
}): ReactElement | null {
  const call = useCall();
  const list = useGatewayQuery("nudges.list", { entityId });
  const prefill = usePrefillComposer();
  if (list.data === undefined || !list.data.enabled) return null;
  const { items, muted } = list.data;
  const first = items[0];
  if (muted) {
    return (
      <GroupedList title={t("nudges.person.title")}>
        <div
          className="flex flex-wrap items-center gap-2 px-3 py-1.5"
          data-testid="nudge-person-muted"
        >
          <p className="min-w-0 flex-1 text-body text-label-secondary">
            {t("nudges.person.muted", { name })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void call("nudges.mute", { entityId, muted: false }).finally(() => list.reload())
            }
          >
            {t("nudges.person.unmute")}
          </Button>
        </div>
      </GroupedList>
    );
  }
  if (first === undefined) return null;
  return (
    <GroupedList title={t("nudges.person.title")}>
      <div className="flex flex-col gap-2 px-3 py-1.5" data-testid="nudge-person-row">
        <p className="text-body">{first.text}</p>
        <NudgeActions
          key={first.id}
          item={first}
          {...(prefill ? { onDraft: prefill } : {})}
          onAct={(action: NudgeAction) =>
            call("nudges.act", { id: first.id, action }).finally(() => list.reload())
          }
        />
      </div>
    </GroupedList>
  );
}
