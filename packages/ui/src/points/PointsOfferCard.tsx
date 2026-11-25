import { Crosshair } from "lucide-react";
import type { ReactElement } from "react";
import { Card } from "../blocks/card.tsx";
import type { BlockOf } from "../blocks/types.ts";
import { t } from "../i18n/core.ts";
import { keysLabel } from "../lib/keys.ts";
import { usePoints } from "./PointsContext.tsx";

/**
 * The `points_offer` block (docs/design/psyche-points-2026.md §6.2): the card the agent's
 * `points.offer {goal}` tool leaves in Chat. It starts nothing: the button opens the start sheet
 * with the goal filled in, and Start there is a second click. The goal is the model's text, drawn
 * as plain text and passed on as `goalSource: "offer"`, never as the owner's own words.
 *
 * Where Points isn't available (a window onto another Mac's Gateway, a Host that isn't a Mac,
 * Points off) the card says where to start it instead and offers no button.
 */
export function PointsOfferCard({
  block,
  threadId,
}: {
  block: BlockOf<"points_offer">;
  /** The chat the offer sits in; a session started from it leaves its closing note there. */
  threadId?: string;
}): ReactElement {
  const points = usePoints();
  const goal = block.goal.trim();
  return (
    <Card
      label={t("points.sheet.title")}
      icon={<Crosshair />}
      title={t("points.sheet.title")}
      data-testid="points-offer"
      actions={
        points.available
          ? [
              {
                id: "points-offer",
                label: t("points.offer.button"),
                kind: "open",
                primary: true,
                onSelect: () =>
                  points.open({
                    entry: "chat",
                    goal,
                    goalSource: "offer",
                    ...(threadId === undefined ? {} : { threadId }),
                  }),
              },
            ]
          : []
      }
    >
      {goal === "" ? null : (
        <p className="text-body text-label-primary" data-testid="points-offer-goal">
          {goal}
        </p>
      )}
      <p className="text-callout text-label-secondary">
        {points.available
          ? t("points.offer.hint")
          : t("points.offer.elsewhere", { keys: keysLabel("Mod+K") })}
      </p>
    </Card>
  );
}
