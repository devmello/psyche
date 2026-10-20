import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import type { WrapUpBlock } from "./types.ts";

/**
 * End-of-turn box from `wrap_up` (UI design §3.2): recap ≤ 300 chars, one question, 1–2 buttons.
 * The text is the model's, which may echo untrusted content, so it goes through the card
 * value-slot sanitizer (design-12); a button still sends its original message back.
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
  const actions = (block.actions ?? []).slice(0, 2);
  return (
    <article
      aria-label={t("blocks.wrapUp.label")}
      className="my-2 rounded-lg border border-gray-6 bg-gray-2 p-3 psy-enter"
    >
      <p className="text-sm text-foreground">{recap}</p>
      {ask ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="me-auto text-sm font-medium">{ask}</p>
          {actions.map((a, i) => (
            <Button
              key={a.label}
              size="sm"
              variant={i === 0 ? "default" : "outline"}
              disabled={answered}
              onClick={() => onAction?.(a.message ?? a.label)}
            >
              {sanitizeDisplay(a.label, 60)}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
