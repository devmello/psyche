import { ArrowLeft, MessageSquare } from "lucide-react";
import type { ReactElement } from "react";
import { canContinueInChat, continueItemOf, useContinueInChat } from "../chat/continue-in-chat.ts";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { ConnectedEntityCard } from "../people/ConnectedEntityCard.tsx";
import { entityHref, kindForEntity, memoryHref } from "./kinds.ts";

/**
 * One person, project or place at page width, inside the Memory page
 * (docs/design/memory-everything-2026.md §6.3), with Back to the list it belongs to. The sheet
 * form stays for Search and ⌘K previews.
 */
export function EntityPage({
  id,
  now,
  onNavigate,
}: {
  id: string;
  now?: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  const detail = useGatewayQuery("memory.entities.get", { id });
  const kind = kindForEntity(detail.data?.entity.kind ?? "person");
  const back = t(`memory.page.kind.${kind}`);
  const continueInChat = useContinueInChat();
  const data = detail.data;
  // A Keep-private item stays on its page: the agent cannot read it, so there is nothing to continue.
  const canContinue =
    continueInChat !== undefined &&
    data !== undefined &&
    data.entity.private !== true &&
    canContinueInChat(data.entity.kind);
  return (
    <div className="flex flex-col gap-3" data-testid="memory-entity">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onNavigate(memoryHref(kind))}
        >
          <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
          {t("memory.page.back", { tab: back })}
        </Button>
        {canContinue ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => continueInChat(continueItemOf(data))}
          >
            <MessageSquare aria-hidden="true" />
            {t("memory.page.continue")}
          </Button>
        ) : null}
      </div>
      <ConnectedEntityCard
        key={id}
        id={id}
        {...(now === undefined ? {} : { now })}
        onOpenEntity={(other) => onNavigate(entityHref(other))}
        onForgotten={() => onNavigate(memoryHref(kind))}
      />
    </div>
  );
}
