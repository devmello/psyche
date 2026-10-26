import type { ReactElement } from "react";
import { usePersona, useSlots } from "../slots.tsx";
import { EntityCard, type EntityCardActions } from "./EntityCard.tsx";
import { useEntityCard } from "./hooks.ts";

export interface ConnectedEntityCardProps {
  id: string;
  /** The clock for due and overdue (stories and tests pass the fixture clock). */
  now?: number;
  recentLimit?: number;
  className?: string;
  /** Opens a related card; defaults to the People & projects section of Soul & Memory. */
  onOpenEntity?: (id: string) => void;
  onMerge?: EntityCardActions["onMerge"];
  onForget?: EntityCardActions["onForget"];
}

/** The card for one entity, loaded from the Gateway, with the owner's edits wired in. */
export function ConnectedEntityCard({
  id,
  now,
  recentLimit,
  className,
  onOpenEntity,
  onMerge,
  onForget,
}: ConnectedEntityCardProps): ReactElement {
  const { navigate, openExternal } = useSlots();
  const persona = usePersona();
  const card = useEntityCard(id, now);
  const open =
    onOpenEntity ??
    ((other: string) => navigate?.(`/agent/soul?entity=${encodeURIComponent(other)}`));
  return (
    <EntityCard
      entity={card.entity}
      now={now ?? Date.now()}
      persona={persona.name}
      loading={card.loading}
      loadingDelayMs={150}
      error={card.error}
      onRetry={card.reload}
      busy={card.busy}
      {...(recentLimit !== undefined ? { recentLimit } : {})}
      {...(className ? { className } : {})}
      onSetFact={card.setFact}
      onRetractFact={card.retractFact}
      onUpdateLoop={card.updateLoop}
      onSetStatus={card.setStatus}
      onTogglePin={card.togglePin}
      onOpenEntity={open}
      {...(openExternal ? { onOpenLink: (link: string) => void openExternal(link) } : {})}
      {...(onMerge ? { onMerge } : {})}
      {...(onForget ? { onForget } : {})}
    />
  );
}
