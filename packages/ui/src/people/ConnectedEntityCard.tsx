import { type ReactElement, useState } from "react";
import { usePersona, useSlots } from "../slots.tsx";
import { EntityCard, type EntityCardActions } from "./EntityCard.tsx";
import { ForgetEntityDialog, MergeEntityDialog } from "./EntityDialogs.tsx";
import { useEntityCard } from "./hooks.ts";

export interface ConnectedEntityCardProps {
  id: string;
  /** The clock for due and overdue (stories and tests pass the fixture clock). */
  now?: number;
  recentLimit?: number;
  className?: string;
  /** Opens a related card; defaults to the People & projects section of Soul & Memory. */
  onOpenEntity?: (id: string) => void;
  /** Replaces the built-in Merge dialog. */
  onMerge?: EntityCardActions["onMerge"];
  /** Replaces the built-in Forget dialog. */
  onForget?: EntityCardActions["onForget"];
  /** After the entity was forgotten (the host closes the card). */
  onForgotten?: () => void;
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
  onForgotten,
}: ConnectedEntityCardProps): ReactElement {
  const { navigate, openExternal } = useSlots();
  const persona = usePersona();
  const card = useEntityCard(id, now);
  const [dialog, setDialog] = useState<"merge" | "forget" | null>(null);
  const target = card.entity ? { id: card.entity.id, name: card.entity.name } : null;
  const open =
    onOpenEntity ??
    ((other: string) => navigate?.(`/agent/soul?entity=${encodeURIComponent(other)}`));
  return (
    <>
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
        onMerge={onMerge ?? (() => setDialog("merge"))}
        onForget={onForget ?? (() => setDialog("forget"))}
      />
      <MergeEntityDialog
        entity={target}
        open={dialog === "merge"}
        onOpenChange={(o) => setDialog(o ? "merge" : null)}
        onMerged={() => card.reload()}
      />
      <ForgetEntityDialog
        entity={target}
        open={dialog === "forget"}
        onOpenChange={(o) => setDialog(o ? "forget" : null)}
        {...(onForgotten ? { onForgotten } : {})}
      />
    </>
  );
}
