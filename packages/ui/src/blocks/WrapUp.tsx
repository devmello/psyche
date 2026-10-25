import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { CardEnter, useEntersLater } from "./QuestionCard.tsx";
import type { WrapUpBlock } from "./types.ts";

/**
 * End-of-turn box from `wrap_up` (UI design §3.2): recap ≤ 300 chars, one question, 1–2 buttons.
 * The text is the model's, which may echo untrusted content, so it goes through the card
 * value-slot sanitizer (design-12); a button still sends its original message back.
 *
 * Redesign 2026 (§5.3): a level-1 card in the transcript, not a second dock. The recap reads in
 * `text-reading`, the question in `text-headline`; the first action is the primary and sits on
 * the trailing side, the second is a secondary button before it.
 */
export function WrapUpBox({
  block,
  onAction,
  answered = false,
}: {
  block: WrapUpBlock;
  onAction?: (message: string) => void;
  answered?: boolean;
}): ReactElement {
  const later = useEntersLater();
  const recap = sanitizeDisplay(
    block.recap.length > 300 ? `${block.recap.slice(0, 299)}…` : block.recap,
  );
  const ask = block.ask === undefined ? undefined : sanitizeDisplay(block.ask, 300);
  const actions = (block.actions ?? []).slice(0, 2).map((a, i) => ({ ...a, primary: i === 0 }));
  // Primary trailing (§3.8): the secondary comes first in reading and focus order.
  const ordered = [...actions].reverse();
  return (
    <CardEnter animate={later}>
      <article
        aria-label={t("blocks.wrapUp.label")}
        className="my-2 rounded-lg bg-surface-raised p-4 text-label-primary shadow-elevation-1"
      >
        <p className="text-reading">{recap}</p>
        {ask ? (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <p className="me-auto text-headline">{ask}</p>
            {ordered.map((a) => (
              <Button
                key={a.label}
                variant={a.primary ? "default" : "secondary"}
                disabled={answered}
                onClick={() => onAction?.(a.message ?? a.label)}
              >
                {sanitizeDisplay(a.label, 60)}
              </Button>
            ))}
          </div>
        ) : null}
      </article>
    </CardEnter>
  );
}
