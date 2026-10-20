import { renderForSurface, sanitizeApproval } from "@psyche/permissions/cards";
import type { ApprovalRequest, GrantScope } from "@psyche/protocol";
import { ChevronRight, Fingerprint, ShieldCheck } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/button.tsx";
import { Label } from "../components/ui/label.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group.tsx";
import { formatCountdown, formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { ApprovalDetails, ApprovalIds } from "./approval-details.tsx";

/**
 * Approval card (UI design §3.3). Host-rendered, fixed structure and button order, never inside a
 * message (§1.2 principle 4). Deny is preselected; Return does nothing; ⌘Return submits the
 * selected choice; ⌘D denies; buttons arm 400 ms after the card appears and never move.
 *
 * What the card shows is the desktop rendering from `@psyche/permissions/cards` (review
 * design-12): the fixed template header (`renderForSurface("desktop", …)`) and a copy of the
 * request whose summary, target and details went through the same value-slot sanitizer every
 * other surface uses, so the desktop card and the chat cards cannot drift.
 */

/** Asks the thread's dock to open (and focus) one approval card; the inline pointer sends it. */
export const FOCUS_APPROVAL_EVENT = "psyche:focus-approval";

export function focusApproval(approvalId: string): void {
  window.dispatchEvent(new CustomEvent(FOCUS_APPROVAL_EVENT, { detail: approvalId }));
}

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

/**
 * Expiry choices under Always allow (UI design §3.3), limited to the grant scopes an answer can
 * carry: `session` ends with this session, `always` lasts until revoked in Settings (the Broker
 * may still cap it by policy).
 */
const UNTIL_LABEL: Record<"session" | "always", string> = {
  session: "until this session ends",
  always: "until revoked",
};

const SCOPE_LABEL: Record<GrantScope, string> = {
  once: "Allow once",
  task: "Allow for this task",
  site: "Allow for this site",
  session: "Allow for this session",
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
  approval: raw,
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
  const approval = useMemo(() => sanitizeApproval(raw), [raw]);
  // First line of the per-surface template: kind · side effect · taint (never attacker text).
  const header = useMemo(() => renderForSurface("desktop", raw).text.split("\n")[0] ?? "", [raw]);
  const now = useNow(1000, fixedNow);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [choice, setChoice] = useState<ApprovalChoice>("deny");
  // The narrower lifetime is the default (until this session ends), when it is offered.
  const [alwaysScope, setAlwaysScope] = useState<"always" | "session">(
    approval.scopesOffered.includes("session") ? "session" : "always",
  );
  const [armed, setArmed] = useState(armDelayMs === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showIds, setShowIds] = useState(false);

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

  // Buttons arm 400 ms after the card becomes answerable, including when a stale card is
  // re-issued under the same key (UI design §3.3).
  useEffect(() => {
    if (!interactive) return;
    if (armDelayMs === 0) {
      setArmed(true);
      return;
    }
    setArmed(false);
    const t = setTimeout(() => setArmed(true), armDelayMs);
    return () => clearTimeout(t);
  }, [interactive, armDelayMs]);
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
  // The Broker's own reason when the Gateway sends one (docs/status/s12.md, gap 3).
  const reason = (approval.details as Record<string, unknown>).reason;
  const why =
    typeof reason === "string" && reason.trim() !== ""
      ? reason
      : [mode ? `${mode} mode` : null, approval.sideEffect ?? null, taint]
          .filter(Boolean)
          .join("; ");

  return (
    <fieldset
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      data-approval-id={approval.id}
      data-status={stale ? "stale" : expiredByClock ? "expired" : approval.status}
      className={cn(
        // Level 1 (§4.4): gray-2 with a 1 px border, amber while it waits for an answer.
        "m-0 min-w-0 rounded-lg border bg-gray-2 p-4 text-sm psy-enter-still",
        pending && !stale ? "border-approval-border" : "border-gray-6",
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
      <p className="mt-1 text-xs font-medium text-muted-foreground" data-card-header>
        {header}
      </p>
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="mt-0.5 text-base font-semibold text-foreground outline-none"
      >
        {approval.summary}
      </h3>

      <div className="mt-2">
        <ApprovalDetails approval={approval} persona={persona} />
      </div>

      <dl className="mt-2 border-t border-gray-5 pt-2">
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
                <NativeSelect
                  id={`${headingId}-until`}
                  size="sm"
                  value={alwaysScope}
                  onChange={(e) => {
                    setAlwaysScope(e.target.value as "always" | "session");
                    setChoice("always");
                  }}
                >
                  {offered.includes("session") ? (
                    <option value="session">{UNTIL_LABEL.session}</option>
                  ) : null}
                  {offered.includes("always") ? (
                    <option value="always">{UNTIL_LABEL.always}</option>
                  ) : null}
                </NativeSelect>
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

      <p className="mt-3 truncate text-caption text-muted-foreground">
        Binding <span className="font-mono">{approval.bindingHash.slice(0, 15)}…</span> · any change
        above voids this card
      </p>

      {error ? (
        <p className="mt-2 text-danger-text" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          className="-ml-1.5 text-muted-foreground"
          aria-expanded={showIds}
          aria-controls={`${headingId}-ids`}
          onClick={() => setShowIds((v) => !v)}
        >
          <ChevronRight
            className={cn("transition-transform", showIds && "rotate-90")}
            aria-hidden="true"
          />
          Details
        </Button>
        {interactive ? (
          <div className="ml-auto flex gap-2">
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
              onClick={(e) => {
                // Return and Space on this button never approve; only ⌘Return or a pointer does.
                if (e.detail === 0) return;
                void submit("approve");
              }}
              aria-keyshortcuts="Meta+Enter"
            >
              Allow with scope
            </Button>
          </div>
        ) : null}
      </div>
      {/* Below the buttons, so opening it never moves them (§3.3). */}
      {showIds ? (
        <div id={`${headingId}-ids`} className="mt-2 rounded-md bg-gray-3 px-3 py-2">
          <ApprovalIds approval={approval} />
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
