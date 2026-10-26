import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { Card, type CardAction } from "./card.tsx";
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
  const recap = sanitizeDisplay(
    block.recap.length > 300 ? `${block.recap.slice(0, 299)}…` : block.recap,
  );
  const ask = block.ask === undefined ? undefined : sanitizeDisplay(block.ask, 300);
  const actions: CardAction[] =
    ask === undefined
      ? []
      : (block.actions ?? []).slice(0, 2).map((a, i) => ({
          id: `${i}`,
          label: sanitizeDisplay(a.label, 60),
          kind: "send",
          primary: i === 0,
          disabled: answered,
          onSelect: () => onAction?.(a.message ?? a.label),
        }));
  return (
    <Card
      label={t("blocks.wrapUp.label")}
      actions={actions}
      actionSize="default"
      actionsLead={ask === undefined ? undefined : <p className="text-headline">{ask}</p>}
    >
      <p className="text-reading">{recap}</p>
    </Card>
  );
}
