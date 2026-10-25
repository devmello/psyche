import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { Lightbulb } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../../components/page.tsx";
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
  // One accent primary at a time: the hovered card, else the one holding focus.
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = hovered ?? focused;
  let body: ReactElement;
  if (loading) {
    body = showSkeleton ? (
      <LoadingCards label={t("screens.ideas.loading")} count={3} lines={4} />
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
          <ListItem
            key={idea.id}
            index={i}
            onPointerEnter={() => setHovered(idea.id)}
            onPointerLeave={() => setHovered((h) => (h === idea.id ? null : h))}
            onFocus={() => setFocused(idea.id)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setFocused((f) => (f === idea.id ? null : f));
              }
            }}
          >
            <IdeaCard
              idea={idea}
              prominent={active === idea.id}
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

/** Connected Ideas: `ideas.list`, `ideas.accept` (with `recurring`), `ideas.dismiss`. */
export function IdeasScreen({ onEdit, onViewSkill }: IdeasScreenProps): ReactElement {
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
