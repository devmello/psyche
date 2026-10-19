import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import type { WrapUpBlock } from "./types.ts";

/** End-of-turn box from `wrap_up` (UI design §3.2): recap ≤ 300 chars, one question, 1–2 buttons. */
export function WrapUpBox({
  block,
  onAction,
  answered = false,
}: {
  block: WrapUpBlock;
  onAction?: (message: string) => void;
  answered?: boolean;
}): ReactElement {
  const recap = block.recap.length > 300 ? `${block.recap.slice(0, 299)}…` : block.recap;
  const actions = (block.actions ?? []).slice(0, 2);
  return (
    <section
      aria-label="Wrap-up"
      className="my-2 rounded-lg border border-gray-6 bg-gray-2 p-3 psy-enter"
    >
      <p className="text-sm text-foreground">{recap}</p>
      {block.ask ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm font-medium">{block.ask}</p>
          {actions.map((a, i) => (
            <Button
              key={a.label}
              size="sm"
              variant={i === 0 ? "default" : "outline"}
              disabled={answered}
              onClick={() => onAction?.(a.message ?? a.label)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
