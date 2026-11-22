import type { SpaceMigrationOffer, SpaceProposal, TaintSource } from "@psyche/protocol";
import { Layers } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { spaceHref } from "../spaces/use-spaces.ts";

/**
 * Space suggestions on Home (docs/design/spaces-2026.md §4.3, §8). The agent only proposes, and
 * the migration only offers: nothing becomes a Space until the owner taps Create. A proposal made
 * in a turn that read untrusted content says so, names its source, and shows its reason as quoted
 * data (SR9).
 */

/** Where a proposal's turn read from, as one line of data (`email · mallory@x.test`). */
export function taintLine(taint: readonly TaintSource[]): string {
  return taint
    .slice(0, 3)
    .map((s) => [s.sourceKind, s.origin ?? s.sender].filter((x) => x !== undefined).join(" · "))
    .join(", ");
}

/** The open proposals and the migration offer, each as a Suggestions item. */
export function useSpaceSuggestions(): {
  proposals: readonly SpaceProposal[];
  migration: SpaceMigrationOffer | null;
  /** Re-reads both (after a dismiss, which raises no event). */
  reload: () => void;
} {
  const proposals = useGatewayQuery("spaces.proposals.list", { status: "open" });
  const migration = useGatewayQuery("spaces.migration.offer", {});
  return {
    proposals: proposals.data?.proposals ?? [],
    migration: migration.data?.offer ?? null,
    reload: () => {
      proposals.reload();
      migration.reload();
    },
  };
}

const cardClass = "flex flex-col gap-2 rounded-lg bg-surface-raised p-3 shadow-elevation-1";

export function SpaceProposalCard({
  proposal,
  quiet = true,
  onNavigate,
  onChanged,
}: {
  proposal: SpaceProposal;
  quiet?: boolean;
  onNavigate?: (to: string) => void;
  onChanged?: () => void;
}): ReactElement {
  const titleId = useId();
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const untrusted = proposal.taint.length > 0;
  const create = () => {
    setBusy(true);
    call("spaces.proposals.accept", { proposalId: proposal.id }).then(
      ({ space }) => {
        onChanged?.();
        toast(t("spaces.proposal.created", { name: space.name }), {
          action: {
            label: t("spaces.proposal.open"),
            onClick: () => onNavigate?.(spaceHref(space.id)),
          },
        });
      },
      (err: unknown) => {
        setBusy(false);
        toast.error(t("spaces.proposal.failed", { reason: describeError(err) }));
      },
    );
  };
  const dismiss = () => {
    setBusy(true);
    call("spaces.proposals.dismiss", { proposalId: proposal.id }).then(
      () => onChanged?.(),
      (err: unknown) => {
        setBusy(false);
        toast.error(t("spaces.proposal.failed", { reason: describeError(err) }));
      },
    );
  };
  return (
    <article aria-labelledby={titleId} className={cardClass}>
      <p className="flex items-center gap-1.5 text-callout text-label-secondary">
        <Layers className="size-3.5" aria-hidden="true" />
        {t("spaces.proposal.kicker")}
      </p>
      {untrusted ? (
        <>
          {/* A tainted proposal's name is third-party text: never in the headline (SR9). */}
          <h3 id={titleId} className="text-headline text-label-primary">
            {t("spaces.proposal.titleUntrusted")}
          </h3>
          <p className="text-callout text-label-secondary">
            {t("spaces.proposal.untrusted", { source: taintLine(proposal.taint) })}
          </p>
          <blockquote className="flex flex-col gap-0.5 border-s-2 border-separator ps-2 text-callout text-label-secondary">
            <span className="text-label-primary">{proposal.name}</span>
            <span>{proposal.reason}</span>
          </blockquote>
        </>
      ) : (
        <>
          <h3 id={titleId} className="text-headline text-label-primary">
            {t("spaces.proposal.title", { name: proposal.name })}
          </h3>
          <p className="text-callout text-label-secondary">{proposal.reason}</p>
        </>
      )}
      <ProposalMoves proposal={proposal} />
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          {...(quiet || untrusted ? { variant: "outline" as const } : {})}
          disabled={busy}
          onClick={create}
        >
          {t("spaces.proposal.create")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={dismiss}>
          {t("spaces.proposal.notNow")}
        </Button>
      </div>
    </article>
  );
}

/** What Create would do, read from the Gateway: the project it links and the chats it moves. */
function ProposalMoves({ proposal }: { proposal: SpaceProposal }): ReactElement {
  const chats = proposal.chats ?? [];
  return (
    <div className="flex flex-col gap-0.5 text-callout text-label-secondary">
      {proposal.entityId == null ? null : (
        <p>{t("spaces.proposal.project", { name: proposal.projectName ?? proposal.entityId })}</p>
      )}
      <p>{t("spaces.proposal.chats", { n: chats.length })}</p>
      {chats.length === 0 ? null : (
        <ul className="list-disc ps-5" aria-label={t("spaces.proposal.chatsLabel")}>
          {chats.map((c) => (
            <li key={c.id} className="truncate">
              {c.title === "" ? t("spaces.proposal.untitledChat") : c.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SpaceMigrationCard({
  offer,
  onNavigate,
  onChanged,
}: {
  offer: SpaceMigrationOffer;
  onNavigate?: (to: string) => void;
  onChanged?: () => void;
}): ReactElement {
  const titleId = useId();
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const chosen = offer.projects.filter((p) => !unchecked.has(p.entityId));
  const toggle = (id: string, on: boolean) =>
    setUnchecked((s) => {
      const next = new Set(s);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    setBusy(true);
    call("spaces.migration.apply", { entityIds: chosen.map((p) => p.entityId) }).then(
      ({ spaces }) => {
        onChanged?.();
        const first = spaces[0];
        toast(t("spaces.migration.created", { n: spaces.length }), {
          ...(spaces.length === 1 && first !== undefined
            ? {
                action: {
                  label: t("spaces.proposal.open"),
                  onClick: () => onNavigate?.(spaceHref(first.id)),
                },
              }
            : {}),
        });
      },
      (err: unknown) => {
        setBusy(false);
        toast.error(t("spaces.proposal.failed", { reason: describeError(err) }));
      },
    );
  };
  const dismiss = () => {
    setBusy(true);
    call("spaces.migration.dismiss", {}).then(
      () => onChanged?.(),
      (err: unknown) => {
        setBusy(false);
        toast.error(t("spaces.proposal.failed", { reason: describeError(err) }));
      },
    );
  };
  return (
    <article aria-labelledby={titleId} className={cardClass}>
      <p className="flex items-center gap-1.5 text-callout text-label-secondary">
        <Layers className="size-3.5" aria-hidden="true" />
        {t("spaces.proposal.kicker")}
      </p>
      <h3 id={titleId} className="text-headline text-label-primary">
        {t("spaces.migration.title")}
      </h3>
      <p className="text-callout text-label-secondary">{t("spaces.migration.hint")}</p>
      <ul className="flex flex-col" aria-label={t("spaces.migration.title")}>
        {offer.projects.map((p) => (
          <li key={p.entityId}>
            <label
              htmlFor={`${titleId}-${p.entityId}`}
              className="flex min-h-11 cursor-default items-center gap-3 rounded-md px-1 py-1.5 hover:bg-fill-quaternary"
            >
              <Checkbox
                id={`${titleId}-${p.entityId}`}
                checked={!unchecked.has(p.entityId)}
                disabled={busy}
                onCheckedChange={(on) => toggle(p.entityId, on === true)}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body text-label-primary">{p.name}</span>
                <span className="truncate text-callout text-label-secondary">
                  {t("spaces.migration.line", { threads: p.threads, folders: p.folders })}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || chosen.length === 0}
          onClick={create}
        >
          {t("spaces.migration.create", { n: chosen.length })}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={dismiss}>
          {t("spaces.proposal.notNow")}
        </Button>
      </div>
    </article>
  );
}
