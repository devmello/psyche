import type { ApprovalRequest, GrantScope } from "@psyche/protocol";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Label } from "../components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group.tsx";
import { formatCountdown, formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { ApprovalDetails } from "./approval-details.tsx";

/**
 * Approval card (UI design §3.3). Host-rendered, fixed structure and button order, never inside a
 * message (§1.2 principle 4). Deny is preselected; Return does nothing; ⌘Return submits the
 * selected choice; ⌘D denies; buttons arm 400 ms after the card appears and never move.
 */

export type ApprovalChoice = "deny" | "once" | "task" | "site" | "always" | "session";

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  /** This surface holds an unused answer token. */
  canAnswer: boolean;
  /** Shown before a reconnect and not yet re-issued. */
  stale?: boolean;
  /** Persona name and the task title, for "Requested by". */
  persona?: string;
  taskTitle?: string | null;
  createdFrom?: string | null;
  /** Thread permission mode, for "Why asked". */
  mode?: string;
  /** Surface labels for "Also sent to" (other than this one). */
  otherSurfaces?: readonly string[];
  onAnswer?: (decision: "approve" | "deny", scope?: GrantScope) => unknown;
  /** Fixed clock (stories, tests). */
  now?: number;
  /** Move focus to the heading on mount unless the user is typing (§4.11). */
  autoFocus?: boolean;
  /** Arming delay; tests may set 0. */
  armDelayMs?: number;
  className?: string;
}

const SCOPE_LABEL: Record<GrantScope, string> = {
  once: "Allow once",
  task: "Allow for this task",
  site: "Allow for this site",
  session: "Always allow",
  always: "Always allow",
};

function originOf(approval: ApprovalRequest): string | null {
  if (approval.target?.kind === "origin") return approval.target.display ?? approval.target.value;
  const d = approval.details as Record<string, unknown>;
  const o = d.origin ?? d.currentOrigin;
  return typeof o === "string" ? o.replace(/^https?:\/\//, "") : null;
}

function statusText(approval: ApprovalRequest, now: number): string | null {
  switch (approval.status) {
    case "approved": {
      const where =
        approval.decidedBy && "surface" in approval.decidedBy && approval.decidedBy.surface
          ? ` on ${approval.decidedBy.surface}`
          : approval.decidedBy && "channel" in approval.decidedBy
            ? ` on ${approval.decidedBy.channel}`
            : "";
      return `Approved${where}${approval.scopeGranted ? ` · ${SCOPE_LABEL[approval.scopeGranted].toLowerCase()}` : ""}${approval.decidedAt ? ` · ${formatRelative(approval.decidedAt, now)}` : ""}`;
    }
    case "denied":
      return `Denied${approval.decidedAt ? ` · ${formatRelative(approval.decidedAt, now)}` : ""}`;
    case "expired":
      return "Expired. Nothing was done.";
    case "invalidated":
      return `Voided${approval.invalidatedReason ? `: ${approval.invalidatedReason}` : ". The arguments changed."}`;
    default:
      return null;
  }
}

export function ApprovalCard({
  approval,
  canAnswer,
  stale = false,
  persona = "The agent",
  taskTitle,
  createdFrom,
  mode,
  otherSurfaces = [],
  onAnswer,
  now: fixedNow,
  autoFocus = false,
  armDelayMs = 400,
  className,
}: ApprovalCardProps): ReactElement {
  const now = useNow(1000, fixedNow);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [choice, setChoice] = useState<ApprovalChoice>("deny");
  const [alwaysScope, setAlwaysScope] = useState<"always" | "session">(
    approval.scopesOffered.includes("always") ? "always" : "session",
  );
  const [armed, setArmed] = useState(armDelayMs === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (armDelayMs === 0) return;
    const t = setTimeout(() => setArmed(true), armDelayMs);
    return () => clearTimeout(t);
  }, [armDelayMs]);

  useEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement;
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (!typing) headingRef.current?.focus();
  }, [autoFocus]);

  const remaining = Date.parse(approval.expiresAt) - now;
  const expiredByClock = approval.status === "pending" && remaining <= 0;
  const pending = approval.status === "pending" && !expiredByClock;
  const interactive = pending && canAnswer && !stale && onAnswer !== undefined;
  const site = originOf(approval);
  const offered = approval.scopesOffered;
  const hasAlways = offered.includes("always") || offered.includes("session");

  const submit = async (decision: "approve" | "deny") => {
    if (!interactive || !armed || busy) return;
    const scope: GrantScope | undefined =
      decision === "deny"
        ? undefined
        : choice === "always" || choice === "session"
          ? alwaysScope
          : (choice as GrantScope);
    setBusy(true);
    setError(null);
    try {
      await onAnswer?.(decision, scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!(e.metaKey || e.ctrlKey)) {
      // Return alone never approves (OpenClaw's rule; UI design §3.3).
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void submit(choice === "deny" ? "deny" : "approve");
    } else if (e.key.toLowerCase() === "d") {
      e.preventDefault();
      void submit("deny");
    }
  };

  const status = statusText(approval, now);
  const taint = approval.taint ? "this turn read untrusted content" : null;
  const why = [mode ? `${mode} mode` : null, approval.sideEffect ?? null, taint]
    .filter(Boolean)
    .join("; ");

  return (
    <fieldset
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      data-status={stale ? "stale" : expiredByClock ? "expired" : approval.status}
      className={cn(
        "m-0 min-w-0 rounded-lg border bg-approval-surface p-4 text-sm psy-enter-still",
        pending && !stale ? "border-approval-border" : "border-gray-6 bg-gray-2",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-approval-text" aria-hidden="true" />
        <span className="font-semibold text-approval-text">
          {pending ? "Approval needed" : "Approval"}
        </span>
        {pending ? (
          <span
            className={cn(
              "ml-auto text-xs tabular-nums",
              remaining < 60_000 ? "font-semibold text-danger-text" : "text-muted-foreground",
            )}
          >
            expires in {formatCountdown(remaining)}
          </span>
        ) : null}
      </div>
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="mt-1 text-base font-semibold text-foreground outline-none"
      >
        {approval.summary}
      </h3>

      <div className="mt-2">
        <ApprovalDetails approval={approval} persona={persona} />
      </div>

      <dl className="mt-2 border-t border-approval-border/40 pt-2">
        <div className="grid grid-cols-[7rem_1fr] gap-2 py-0.5">
          <dt className="text-muted-foreground">Requested by</dt>
          <dd>
            {persona}
            {taskTitle ? ` · task "${taskTitle}"` : ""}
            {createdFrom ? ` (from ${createdFrom})` : ""}
            {approval.requestedBy.agent && approval.requestedBy.agent !== persona
              ? ` · ${approval.requestedBy.agent}`
              : ""}
          </dd>
        </div>
        {why ? (
          <div className="grid grid-cols-[7rem_1fr] gap-2 py-0.5">
            <dt className="text-muted-foreground">Why asked</dt>
            <dd>{why}</dd>
          </div>
        ) : null}
      </dl>

      {status !== null || expiredByClock || stale || (pending && !canAnswer) ? (
        <p className="mt-3 rounded-md bg-gray-3 px-3 py-2 text-foreground" aria-live="polite">
          {stale
            ? "Psyche restarted, so this card is out of date. It will be re-issued if it is still needed."
            : expiredByClock
              ? "Expired. Nothing was done."
              : pending && !canAnswer
                ? "Answer this on the device it was sent to."
                : status}
        </p>
      ) : null}

      {interactive ? (
        <>
          <RadioGroup
            className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2"
            value={choice}
            onValueChange={(v) => setChoice(v as ApprovalChoice)}
            aria-label="Decision"
          >
            {offered.includes("once") ? <Choice value="once" label={SCOPE_LABEL.once} /> : null}
            {offered.includes("task") ? <Choice value="task" label={SCOPE_LABEL.task} /> : null}
            {offered.includes("site") && site !== null ? (
              <Choice value="site" label={SCOPE_LABEL.site} hint={site} />
            ) : null}
            {hasAlways ? (
              <div className="flex items-center gap-2">
                <Choice value="always" label="Always allow" />
                <label className="sr-only" htmlFor={`${headingId}-until`}>
                  Always allow until
                </label>
                <select
                  id={`${headingId}-until`}
                  className="h-7 rounded-md border border-input bg-background px-1 text-xs"
                  value={alwaysScope}
                  onChange={(e) => {
                    setAlwaysScope(e.target.value as "always" | "session");
                    setChoice("always");
                  }}
                >
                  {offered.includes("session") ? (
                    <option value="session">until this session ends</option>
                  ) : null}
                  {offered.includes("always") ? <option value="always">for 90 days</option> : null}
                </select>
              </div>
            ) : null}
            <Choice value="deny" label="Deny" />
          </RadioGroup>

          {approval.requiresAuthentication ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Fingerprint className="size-3.5" aria-hidden="true" /> Needs Touch ID to approve.
            </p>
          ) : null}
          {otherSurfaces.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Also sent to: {otherSurfaces.join(", ")}. The first answer wins.
            </p>
          ) : null}
        </>
      ) : null}

      <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
        Binding {approval.bindingHash.slice(0, 15)}… · any change above voids this card
      </p>

      {error ? (
        <p className="mt-2 text-danger-text" role="alert">
          {error}
        </p>
      ) : null}

      {interactive ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!armed || busy}
            onClick={() => void submit("deny")}
            aria-keyshortcuts="Meta+D"
          >
            Deny
          </Button>
          <Button
            disabled={!armed || busy || choice === "deny"}
            onClick={() => void submit("approve")}
            aria-keyshortcuts="Meta+Enter"
          >
            Allow with scope
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

function Choice({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem value={value} id={id} />
      <Label htmlFor={id} className="font-normal">
        {label}
        {hint ? <span className="text-muted-foreground"> {hint}</span> : null}
      </Label>
    </div>
  );
}
