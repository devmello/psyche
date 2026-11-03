import { ArrowLeft } from "lucide-react";
import type { ReactElement } from "react";
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
  return (
    <div className="flex flex-col gap-3" data-testid="memory-entity">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onNavigate(memoryHref(kind))}
      >
        <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
        {t("memory.page.back", { tab: back })}
      </Button>
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
