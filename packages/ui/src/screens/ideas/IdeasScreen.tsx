import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { Lightbulb } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { DelayedSkeletons } from "../../components/DelayedSkeleton.tsx";
import { EmptyState, ErrorState, useDelayedFlag } from "../../components/page.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { useIdeas } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { ListItem } from "../../motion/index.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { ScreenColumn, ScreenToolbar } from "../feed/ScreenToolbar.tsx";
import { type IdeaAcceptOptions, IdeaCard } from "./IdeaCard.tsx";

export interface IdeasViewProps {
  ideas: readonly Idea[];
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  busyIds?: ReadonlySet<string>;
  persona?: string;
  onAccept?: (idea: Idea, options: IdeaAcceptOptions) => void;
  onEdit?: (idea: Idea) => void;
  onDismiss?: (idea: Idea, reason: IdeaDismissReason) => void;
  onViewSkill?: (idea: Idea) => void;
  onOpenRoute?: (route: string) => void;
  /** The empty state's one action. */
  onOpenChat?: () => void;
}

/** Ideas (UI design §3.10). Presentational. */
export function IdeasView({
  ideas,
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  busyIds,
  persona = "Wren",
  onAccept,
  onEdit,
  onDismiss,
  onViewSkill,
  onOpenRoute,
  onOpenChat,
}: IdeasViewProps): ReactElement {
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  let body: ReactElement;
  if (loading) {
    body = showSkeleton ? (
      // An idea card: title and kind chip, two body lines, the evidence line, then the actions.
      <DelayedSkeletons label={t("screens.ideas.loading")} className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2.5 rounded-lg bg-surface-raised p-4 shadow-elevation-1"
          >
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <div className="flex justify-end gap-2 pt-1">
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-7 w-12" />
            </div>
          </div>
        ))}
      </DelayedSkeletons>
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what={t("screens.ideas.loadFailed")}
        reason={error}
        did={t("screens.ideas.nothingChanged")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (ideas.length === 0) {
    body = (
      <EmptyState
        icon={Lightbulb}
        {...(onOpenChat
          ? { action: { label: t("screens.ideas.talkTo", { name: persona }), onClick: onOpenChat } }
          : {})}
      >
        {t("screens.ideas.empty")}
      </EmptyState>
    );
  } else {
    body = (
      <ul aria-label={t("screens.ideas.title")} className="flex flex-col gap-3">
        {ideas.map((idea, i) => (
          <ListItem key={idea.id} index={i}>
            <IdeaCard
              idea={idea}
              prominent={i === 0}
              busy={busyIds?.has(idea.id) ?? false}
              {...(onAccept ? { onAccept } : {})}
              {...(onEdit ? { onEdit } : {})}
              {...(onDismiss ? { onDismiss } : {})}
              {...(onViewSkill ? { onViewSkill } : {})}
              {...(onOpenRoute ? { onOpenRoute } : {})}
            />
          </ListItem>
        ))}
      </ul>
    );
  }
  return (
    <section aria-label={t("screens.ideas.title")}>
      <ScreenToolbar
        title={t("screens.ideas.title")}
        meta={
          !loading && error === null && ideas.length > 0
            ? t("screens.ideas.count", { n: ideas.length })
            : null
        }
      />
      <ScreenColumn width="wide">
        <p className="text-callout text-label-secondary">{t("screens.ideas.description")}</p>
        {body}
      </ScreenColumn>
    </section>
  );
}

export interface IdeasScreenProps {
  /** Opens the brief in a side-chat composer (§3.10). */
  onEdit?: (idea: Idea) => void;
  /** Defaults to opening `SKILL.md` in the editor (`/agent/soul?file=…`). */
  onViewSkill?: (idea: Idea) => void;
}

/**
 * Accept, dismiss and "View skill" for idea cards, with their toasts and busy ids: shared by the
 * Ideas screen and Home's Suggestions (docs/design/consolidation-2026.md §3.1).
 */
export function useIdeaActions(onViewSkill?: (idea: Idea) => void): {
  ideas: ReturnType<typeof useIdeas>;
  busy: ReadonlySet<string>;
  accept: (idea: Idea, options: IdeaAcceptOptions) => void;
  dismiss: (idea: Idea, reason: IdeaDismissReason) => void;
  viewSkill: (idea: Idea) => void;
} {
  const { navigate } = useSlots();
  const persona = usePersona();
  const ideas = useIdeas();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const track = (id: string, work: Promise<unknown>) => {
    setBusy((s) => new Set(s).add(id));
    return work.finally(() =>
      setBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      }),
    );
  };

  const accept = (idea: Idea, { recurring, schedule }: IdeaAcceptOptions) => {
    // A recurring Task idea needs a schedule (`ideas.accept`); the hook passes options through.
    const options: { recurring?: boolean; schedule?: string } = recurring
      ? { recurring: true, ...(schedule === undefined ? {} : { schedule }) }
      : {};
    track(
      idea.id,
      ideas.accept(idea.id, options).then(
        (r) => {
          toast(
            r.automationId !== null
              ? t("screens.ideas.added", { title: idea.title })
              : t("screens.ideas.started", { name: persona.name, title: idea.title }),
            r.taskId !== null
              ? {
                  action: {
                    label: t("screens.ideas.open"),
                    onClick: () => navigate?.(`/agent/activity/${r.taskId}`),
                  },
                }
              : {},
          );
        },
        (err: unknown) => {
          toast.error(
            t("screens.ideas.startFailed", { title: idea.title, reason: describeError(err) }),
          );
        },
      ),
    );
  };

  const dismiss = (idea: Idea, reason: IdeaDismissReason) => {
    track(
      idea.id,
      ideas.dismiss(idea.id, reason).then(
        () => {
          toast(t(`screens.ideas.dismissed.${reason}`));
        },
        (err: unknown) => {
          toast.error(
            t("screens.ideas.dismissFailed", { title: idea.title, reason: describeError(err) }),
          );
        },
      ),
    );
  };

  const viewSkill =
    onViewSkill ??
    ((idea: Idea) => {
      if (idea.resultRef != null)
        navigate?.(`/agent/soul?file=${encodeURIComponent(idea.resultRef)}`);
    });

  return { ideas, busy, accept, dismiss, viewSkill };
}

/** Connected Ideas: `ideas.list`, `ideas.accept` (with `recurring`), `ideas.dismiss`. */
export function IdeasScreen({ onEdit, onViewSkill }: IdeasScreenProps): ReactElement {
  const { navigate } = useSlots();
  const persona = usePersona();
  const { ideas, busy, accept, dismiss, viewSkill } = useIdeaActions(onViewSkill);
  return (
    <IdeasView
      ideas={ideas.proposed}
      loading={ideas.loading && ideas.proposed.length === 0}
      loadingDelayMs={150}
      error={ideas.proposed.length === 0 ? ideas.error : null}
      onRetry={ideas.reload}
      busyIds={busy}
      persona={persona.name}
      onAccept={accept}
      onDismiss={dismiss}
      onViewSkill={viewSkill}
      onOpenRoute={(route) => navigate?.(route)}
      onOpenChat={() => navigate?.("/chat")}
      {...(onEdit ? { onEdit } : {})}
    />
  );
}
