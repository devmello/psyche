import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { AnsweredClaims } from "../screens/search/LifeAnswerCard.tsx";
import { groundedClaims } from "../screens/search/life-answer.ts";
import type { BlockOf } from "./types.ts";

/**
 * The answer a chat was opened from (docs/roadmap/future-features.md §1): the same claims and
 * citation chips as the card in Search. A chip opens its source in the source viewer
 * (`search.document`), which applies this connection's own rules again. The Gateway has already
 * read the citations for this connection, so what is here is only what it may open. The words
 * were written by a model from other people's mail and messages: plain text, never Markdown.
 */
export function LifeAnswerView({ block }: { block: BlockOf<"life_answer"> }): ReactElement | null {
  const claims = groundedClaims(block.answer, block.facts, block.passages);
  if (claims.length === 0) return null;
  return (
    <section
      className="my-1 flex flex-col gap-1.5 rounded-md border-[0.5px] border-separator bg-fill-tertiary px-3 py-2"
      aria-label={t("blocks.lifeAnswer.label")}
      data-testid="life-answer-block"
    >
      <AnsweredClaims claims={claims} onOpenEntity={undefined} />
    </section>
  );
}
