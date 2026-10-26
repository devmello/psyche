import type { GrowthCard as GrowthCardData, GrowthCardItem } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { useTeaching } from "./hooks.ts";
import { LessonDetails } from "./LessonMark.tsx";

type Outcome = "kept" | "forgotten" | "remembered" | "declined";

/**
 * One item of the weekly "What I learned" card (teaching loop §5.4): a review queue, not a
 * celebration. Lessons, retirements and conflicts get Keep / Edit / Forget; questions from
 * implicit evidence get Yes, remember and No.
 */
function CardItem({ postId, item }: { postId: string; item: GrowthCardItem }): ReactElement {
  const teach = useTeaching();
  const persona = usePersona();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const act = async (action: () => Promise<unknown>, next: Outcome) => {
    try {
      await action();
      setOutcome(next);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  };
  const lessonId = item.lessonId ?? null;
  const done =
    outcome === null ? null : t(`screens.growth.card.${outcome}`, { agent: persona.name });
  return (
    <li
      className="flex flex-col gap-1.5 py-2.5"
      data-testid="growth-card-item"
      data-type={item.type}
    >
      <span className="text-body text-label-primary">{item.statement}</span>
      <span className="text-callout text-label-secondary">{item.because}</span>
      {done ? (
        <p className="text-callout text-label-secondary" role="status">
          {done}
        </p>
      ) : item.type === "question" ? (
        <span className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(
                () =>
                  teach.give({
                    target: { type: "feed_post", id: postId },
                    kind: "correction",
                    text: item.statement,
                    scope: "always",
                  }),
                "remembered",
              )
            }
          >
            {t("screens.growth.card.yes")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(
                () =>
                  teach.give({ target: { type: "feed_post", id: postId }, kind: "not_helpful" }),
                "declined",
              )
            }
          >
            {t("screens.growth.card.no")}
          </Button>
        </span>
      ) : lessonId !== null ? (
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act(() => teach.confirm(lessonId), "kept")}
          >
            {t("screens.growth.card.keep")}
          </Button>
          <Popover open={editing} onOpenChange={setEditing}>
            <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
              {t("common.edit")}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80">
              {editing ? (
                <LessonDetails lessonId={lessonId} onDone={() => setEditing(false)} />
              ) : null}
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger-text"
            onClick={() => void act(() => teach.forget(lessonId), "forgotten")}
          >
            {t("screens.growth.card.forget")}
          </Button>
        </span>
      ) : null}
      {error ? (
        <p className="text-callout text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** The weekly card's items and its one "Open Growth" link, inside the Feed post. */
export function GrowthCardItems({
  postId,
  card,
}: {
  postId: string;
  card: GrowthCardData;
}): ReactElement {
  const { navigate } = useSlots();
  return (
    <div className="flex flex-col">
      <ul aria-label={t("screens.growth.card.items")} className="divide-y divide-separator">
        {card.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a card's items never reorder
          <CardItem key={i} postId={postId} item={item} />
        ))}
      </ul>
      {navigate ? (
        <Button
          size="sm"
          variant="link"
          className="self-start px-0"
          onClick={() => navigate("/agent/growth")}
        >
          {t("screens.growth.card.open")}
        </Button>
      ) : null}
    </div>
  );
}
