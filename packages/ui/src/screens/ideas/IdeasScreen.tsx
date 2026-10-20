import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { Lightbulb } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  Page,
  PageHeader,
  useDelayedFlag,
} from "../../components/page.tsx";
import { useIdeas } from "../../data/hooks.ts";
import { plural } from "../../lib/format.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { DISMISS_OPTIONS, type IdeaAcceptOptions, IdeaCard } from "./IdeaCard.tsx";

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
      <LoadingCards label="Loading ideas" count={3} lines={4} />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what="Psyche couldn't load your ideas"
        reason={error}
        did="No idea was accepted or dismissed."
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (ideas.length === 0) {
    body = (
      <EmptyState
        icon={Lightbulb}
        {...(onOpenChat ? { action: { label: `Talk to ${persona}`, onClick: onOpenChat } } : {})}
      >
        Ideas come from your goals, conversations and connected accounts.
      </EmptyState>
    );
  } else {
    body = (
      <ul aria-label="Ideas" className="flex flex-col gap-4">
        {ideas.map((idea) => (
          <li key={idea.id}>
            <IdeaCard
              idea={idea}
              busy={busyIds?.has(idea.id) ?? false}
              {...(onAccept ? { onAccept } : {})}
              {...(onEdit ? { onEdit } : {})}
              {...(onDismiss ? { onDismiss } : {})}
              {...(onViewSkill ? { onViewSkill } : {})}
              {...(onOpenRoute ? { onOpenRoute } : {})}
            />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section aria-label="Ideas">
      <Page width="wide">
        <PageHeader
          title="Ideas"
          meta={
            !loading && error === null && ideas.length > 0 ? plural(ideas.length, "idea") : null
          }
          description="Accepted ideas become tasks or automations; nothing runs until you say so."
        />
        {body}
      </Page>
    </section>
  );
}

export interface IdeasScreenProps {
  /** Opens the brief in a side-chat composer (§3.10). */
  onEdit?: (idea: Idea) => void;
  /** Defaults to opening `SKILL.md` in the editor (`/agent/soul?file=…`). */
  onViewSkill?: (idea: Idea) => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
              ? `Added "${idea.title}" to Upcoming.`
              : `${persona.name} started "${idea.title}".`,
            r.taskId !== null
              ? {
                  action: {
                    label: "Open",
                    onClick: () => navigate?.(`/agent/activity/${r.taskId}`),
                  },
                }
              : {},
          );
        },
        (err: unknown) => {
          toast.error(`Psyche couldn't start "${idea.title}" (${messageOf(err)}). Nothing ran.`);
        },
      ),
    );
  };

  const dismiss = (idea: Idea, reason: IdeaDismissReason) => {
    const label = DISMISS_OPTIONS.find((o) => o.reason === reason)?.label ?? "Dismissed";
    track(
      idea.id,
      ideas.dismiss(idea.id, reason).then(
        () => {
          toast(`Dismissed: ${label.toLowerCase()}.`);
        },
        (err: unknown) => {
          toast.error(`Psyche couldn't dismiss "${idea.title}" (${messageOf(err)}).`);
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
