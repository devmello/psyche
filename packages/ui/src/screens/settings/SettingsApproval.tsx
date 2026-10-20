import { Fingerprint } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { ApprovalCard } from "../../blocks/ApprovalCard.tsx";
import { answerApproval, useApproval } from "../../data/hooks.ts";
import { useStore } from "../../data/provider.tsx";
import { usePersona } from "../../slots.tsx";
import { settingLabel } from "./setting-labels.ts";
import {
  hasCode,
  messageOf,
  type PendingSettingApproval,
  SettingsApprovalContext,
} from "./shared.tsx";

/**
 * Security settings need `operator.admin` plus fresh user presence (security §10). The Gateway
 * answers the first `settings.set` with `approval_required` and a device-only `policy_change`
 * card bound to the key and value; this provider shows that card above the section, waits for
 * the owner to approve it (here or in the Psyche notification, with Touch ID or a passkey),
 * then writes the value again with the `approvalId`, which the Gateway consumes once.
 */

type Outcome = { kind: "ok" | "error"; text: string };

/** The reason the broker gives when an answer lacks a presence assertion. */
function presenceReason(err: unknown): "presence_required" | "presence_invalid" | null {
  if (!hasCode(err, "forbidden")) return null;
  const reason = (err as { details?: { reason?: unknown } }).details?.reason;
  return reason === "presence_required" || reason === "presence_invalid" ? reason : null;
}

export const PRESENCE_UNAVAILABLE =
  "This window can't confirm it's you. Approve the change with Touch ID in the Psyche notification on this Mac, or from a device with a passkey. Nothing changes until then.";

function PendingApprovalBanner({
  pending,
  onDone,
}: {
  pending: PendingSettingApproval;
  onDone: (outcome: Outcome) => void;
}): ReactElement {
  const store = useStore();
  const persona = usePersona();
  const { approval, canAnswer } = useApproval(pending.approvalId);
  const [presenceHint, setPresenceHint] = useState<string | null>(null);
  const retried = useRef(false);
  const status = approval?.status;
  const label = settingLabel(pending.key);

  useEffect(() => {
    if (status === undefined || status === "pending" || retried.current) return;
    retried.current = true;
    if (status === "approved") {
      pending.retry(pending.approvalId).then(
        () => onDone({ kind: "ok", text: `Saved “${label}”.` }),
        (err: unknown) =>
          onDone({
            kind: "error",
            text: `Psyche couldn't save “${label}” (${messageOf(err)}). Nothing changed.`,
          }),
      );
      return;
    }
    onDone({
      kind: "error",
      text:
        status === "denied"
          ? `Not changed: the approval for “${label}” was denied.`
          : `Not changed: the approval for “${label}” ${status === "expired" ? "expired" : "was withdrawn"}. Change it again to ask for a new one.`,
    });
  }, [status, pending, onDone, label]);

  return (
    <section
      aria-label="Approval needed"
      className="flex flex-col gap-3 rounded-lg border border-approval-border bg-gray-2 p-4 text-sm"
      data-testid="settings-approval"
    >
      <p className="flex items-start gap-2">
        <Fingerprint className="mt-0.5 size-4 shrink-0 text-approval-text" aria-hidden="true" />
        <span>
          <span className="font-medium">Approve this change to “{label}”.</span> Security settings
          need Touch ID or a passkey. Approve it here or in the Psyche notification; the setting is
          saved as soon as it is approved.
        </span>
      </p>
      {presenceHint ? (
        <p role="alert" className="text-approval-text">
          {presenceHint}
        </p>
      ) : null}
      {approval ? (
        <ApprovalCard
          approval={approval}
          canAnswer={canAnswer}
          persona={persona.name}
          otherSurfaces={approval.surfaces.filter((s) => s !== "desktop" && s !== "web")}
          onAnswer={async (decision, scope) => {
            try {
              await answerApproval(store, approval.id, decision, scope);
            } catch (err) {
              const reason = presenceReason(err);
              if (reason === null) throw err;
              const text =
                reason === "presence_required"
                  ? PRESENCE_UNAVAILABLE
                  : "Touch ID or the passkey didn't confirm it's you. Try again.";
              setPresenceHint(text);
              throw new Error(text);
            }
          }}
        />
      ) : (
        <p role="status" className="text-muted-foreground">
          Loading the approval…
        </p>
      )}
    </section>
  );
}

export function SettingsApprovalProvider({ children }: { children?: ReactNode }): ReactElement {
  const [pending, setPending] = useState<PendingSettingApproval | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  return (
    <SettingsApprovalContext.Provider
      value={(p) => {
        setOutcome(null);
        setPending(p);
      }}
    >
      {pending ? (
        <PendingApprovalBanner
          key={pending.approvalId}
          pending={pending}
          onDone={(o) => {
            setPending(null);
            setOutcome(o);
          }}
        />
      ) : null}
      {outcome ? (
        <p
          role={outcome.kind === "error" ? "alert" : "status"}
          className={
            outcome.kind === "error"
              ? "rounded-md border border-danger/40 px-3 py-2 text-sm text-danger-text"
              : "rounded-md bg-gray-3 px-3 py-2 text-sm"
          }
          data-testid="settings-approval-outcome"
        >
          {outcome.text}
        </p>
      ) : null}
      {children}
    </SettingsApprovalContext.Provider>
  );
}
