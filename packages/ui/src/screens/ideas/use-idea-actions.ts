import type { Idea, IdeaDismissReason } from "@psyche/protocol";
import { useState } from "react";
import { toast } from "sonner";
import { useIdeas } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import type { IdeaAcceptOptions } from "./IdeaCard.tsx";

/**
 * Accept, dismiss and "View skill" for idea cards, with their toasts and busy ids: Home's
 * Suggestions (docs/design/consolidation-2026.md §3.1; Ideas is no longer a page).
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
