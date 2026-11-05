import type { MethodResult } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { useOpenLink } from "../links/LinkPrompt.tsx";
import { ConnectedAnchors } from "../memory-page/Anchors.tsx";
import { ConnectedTimeline } from "../memory-page/Timeline.tsx";
import { WorkCard } from "../memory-page/WorkCard.tsx";
import { QuickAdd } from "../memory-page/WorkDue.tsx";
import { ConnectedWorkHistory } from "../memory-page/WorkHistory.tsx";
import { PersonNudgeRow } from "../nudges/ConnectedNudges.tsx";
import { usePersona, useSlots } from "../slots.tsx";
import { EntityCard, type EntityCardActions } from "./EntityCard.tsx";
import { ForgetEntityDialog, MergeEntityDialog } from "./EntityDialogs.tsx";
import { useEntityCard } from "./hooks.ts";
import { PersonDataDialog, type PersonDataMode } from "./PersonDataDialog.tsx";

export interface ConnectedEntityCardProps {
  id: string;
  /** The clock for due and overdue (stories and tests pass the fixture clock). */
  now?: number;
  recentLimit?: number;
  className?: string;
  /** Opens a related card; defaults to that entity's page on Memory. */
  onOpenEntity?: (id: string) => void;
  /** Replaces the built-in Merge dialog. */
  onMerge?: EntityCardActions["onMerge"];
  /** Replaces the built-in Forget dialog. */
  onForget?: EntityCardActions["onForget"];
  /** After the entity was forgotten (the host closes the card). */
  onForgotten?: () => void;
  /** Receives the person export (the host saves it); without one the browser downloads it. */
  onExportReady?: (file: MethodResult<"memory.entities.export">) => void;
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
  onExportReady,
}: ConnectedEntityCardProps): ReactElement {
  const { navigate } = useSlots();
  const openLink = useOpenLink();
  const persona = usePersona();
  const card = useEntityCard(id, now);
  const call = useCall();
  const [dialog, setDialog] = useState<"merge" | "forget" | PersonDataMode | null>(null);
  const isPerson = card.entity !== null && card.entity.kind === "person" && id !== "";
  const coming = useGatewayQuery(
    "memory.upcoming",
    { days: 366, entityId: id },
    { enabled: isPerson },
  );
  const target = card.entity ? { id: card.entity.id, name: card.entity.name } : null;
  const open =
    onOpenEntity ?? ((other: string) => navigate?.(`/memory?entity=${encodeURIComponent(other)}`));
  const clock = now ?? Date.now();
  const common = {
    entity: card.entity,
    now: clock,
    persona: persona.name,
    loading: card.loading,
    loadingDelayMs: 150,
    error: card.error,
    onRetry: card.reload,
    busy: card.busy,
    ...(recentLimit !== undefined ? { recentLimit } : {}),
    ...(className ? { className } : {}),
    onSetFact: card.setFact,
    onRetractFact: card.retractFact,
    onUpdateLoop: card.updateLoop,
    onSetStatus: card.setStatus,
    onTogglePin: card.togglePin,
    onOpenEntity: open,
    onOpenLink: openLink,
    onMerge: onMerge ?? (() => setDialog("merge")),
    onForget: onForget ?? (() => setDialog("forget")),
  };
  const work = card.entity;
  return (
    <>
      {work && (work.kind === "project" || work.kind === "assignment") ? (
        // Projects, courses and assignments get the work page (§6.3): status, due date, where you
        // stopped, its assignments, the timeline and the sources linked to it.
        <WorkCard
          {...common}
          onSetWorkStatus={card.setWorkStatus}
          onSetDueAt={card.setDueAt}
          onTogglePrivate={(e) => card.setPrivate(e, e.private !== true)}
          timeline={
            <ConnectedTimeline
              entityId={id}
              now={clock}
              names={new Map((work.assignments ?? []).map((a) => [a.id, a.name]))}
            />
          }
          history={<ConnectedWorkHistory entityId={id} name={work.name} now={clock} />}
          linked={<ConnectedAnchors entityId={id} />}
          {...(work.kind === "project"
            ? {
                addAssignment: (close: () => void) => (
                  <QuickAdd
                    now={clock}
                    parent={{ id: work.id, name: work.name }}
                    onAdded={() => card.reload()}
                    onClose={close}
                  />
                ),
              }
            : {})}
        />
      ) : (
        <EntityCard
          {...common}
          upcoming={(coming.data?.items ?? []).map((i) => i.text)}
          {...(isPerson && card.entity
            ? { keepInTouch: <PersonNudgeRow entityId={id} name={card.entity.name} /> }
            : {})}
          {...(isPerson
            ? {
                onExport: () => {
                  void call("memory.entities.export", { id }).then((file) => {
                    if (onExportReady) onExportReady(file);
                    else downloadZip(file);
                  });
                },
                onForgetSaid: () => setDialog("said"),
                onExclude: (_e: unknown, forget: boolean) =>
                  setDialog(forget ? "exclude_forget" : "exclude"),
              }
            : {})}
        />
      )}
      <PersonDataDialog
        person={target}
        mode={
          dialog === "said" || dialog === "exclude" || dialog === "exclude_forget" ? dialog : "said"
        }
        open={dialog === "said" || dialog === "exclude" || dialog === "exclude_forget"}
        onOpenChange={(o) => (o ? undefined : setDialog(null))}
        onDone={() => card.reload()}
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

/** Saves a base64 zip through the browser (a host with its own save flow passes `onExportReady`). */
function downloadZip(file: MethodResult<"memory.entities.export">): void {
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}
