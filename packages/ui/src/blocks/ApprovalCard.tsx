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
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
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
  /** Caps the binding rows (the dock scrolls them so the choices and buttons stay in view). */
  detailsClassName?: string;
}

/**
 * Expiry choices under Always allow (UI design §3.3), limited to the grant scopes an answer can
 * carry: `session` ends with this session, `always` lasts until revoked in Settings (the Broker
 * may still cap it by policy).
 */
const untilLabel = (scope: "session" | "always"): string => t(`blocks.approval.until.${scope}`);

const scopeLabel = (scope: GrantScope): string => t(`blocks.approval.scope.${scope}`);

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
          ? approval.decidedBy.surface
          : approval.decidedBy && "channel" in approval.decidedBy
            ? approval.decidedBy.channel
            : "";
      return t("blocks.approval.status.approved", {
        hasWhere: where !== "",
        where,
        hasScope: Boolean(approval.scopeGranted),
        scope: approval.scopeGranted
          ? t(`blocks.approval.scopeGranted.${approval.scopeGranted}`)
          : "",
        hasWhen: Boolean(approval.decidedAt),
        when: approval.decidedAt ? formatRelative(approval.decidedAt, now) : "",
      });
    }
    case "denied":
      return t("blocks.approval.status.denied", {
        hasWhen: Boolean(approval.decidedAt),
        when: approval.decidedAt ? formatRelative(approval.decidedAt, now) : "",
      });
    case "expired":
      return t("blocks.approval.status.expired");
    case "invalidated":
      return approval.invalidatedReason
        ? t("blocks.approval.status.voidedBecause", { reason: approval.invalidatedReason })
        : t("blocks.approval.status.voided");
    default:
      return null;
  }
}

export function ApprovalCard({
  approval: raw,
  canAnswer,
  stale = false,
  persona = t("blocks.common.theAgent"),
  taskTitle,
  createdFrom,
  mode,
  otherSurfaces = [],
  onAnswer,
  now: fixedNow,
  autoFocus = false,
  armDelayMs = 400,
  className,
  detailsClassName,
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
    const timer = setTimeout(() => setArmed(true), armDelayMs);
    return () => clearTimeout(timer);
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
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const hintId = useId();

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
  const whatLabel = t("blocks.approval.whatItWillDo");
  const taint = approval.taint ? t("blocks.approval.taint") : null;
  // The Broker's own reason when the Gateway sends one (docs/status/s12.md, gap 3).
  const reason = (approval.details as Record<string, unknown>).reason;
  const why =
    typeof reason === "string" && reason.trim() !== ""
      ? reason
      : [
          mode ? t("blocks.approval.modeReason", { mode }) : null,
          approval.sideEffect ?? null,
          taint,
        ]
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
          {pending ? t("blocks.approval.titlePending") : t("blocks.approval.title")}
        </span>
        {pending ? (
          <span
            className={cn(
              "ms-auto text-xs tabular-nums",
              remaining < 60_000 ? "font-semibold text-danger-text" : "text-muted-foreground",
            )}
          >
            {t("blocks.approval.expiresIn", { countdown: formatCountdown(remaining) })}
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

      {detailsClassName ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a capped region must scroll by keyboard
        <section className={cn("mt-2", detailsClassName)} aria-label={whatLabel} tabIndex={0}>
          <ApprovalDetails approval={approval} persona={persona} />
        </section>
      ) : (
        <div className="mt-2">
          <ApprovalDetails approval={approval} persona={persona} />
        </div>
      )}

      <dl className="mt-2 border-t border-gray-5 pt-2">
        <div className="grid grid-cols-[7rem_1fr] gap-2">
          <dt className="text-muted-foreground">{t("blocks.approval.requestedBy")}</dt>
          <dd>
            {t("blocks.approval.requester", {
              persona,
              hasTask: Boolean(taskTitle),
              task: taskTitle ?? "",
              hasFrom: Boolean(createdFrom),
              from: createdFrom ?? "",
              hasAgent: Boolean(
                approval.requestedBy.agent && approval.requestedBy.agent !== persona,
              ),
              agent: approval.requestedBy.agent ?? "",
            })}
          </dd>
        </div>
        {why ? (
          <div className="grid grid-cols-[7rem_1fr] gap-2 pt-0.5">
            <dt className="text-muted-foreground">{t("blocks.approval.whyAsked")}</dt>
            <dd>{why}</dd>
          </div>
        ) : null}
      </dl>

      {/* Always mounted so screen readers announce the text when it appears (C7). */}
      <p
        className={
          status !== null || expiredByClock || stale || (pending && !canAnswer)
            ? "mt-3 rounded-md bg-gray-3 px-3 py-2 text-foreground"
            : "sr-only"
        }
        aria-live="polite"
      >
        {stale
          ? t("blocks.approval.stale")
          : expiredByClock
            ? t("blocks.approval.status.expired")
            : pending && !canAnswer
              ? t("blocks.approval.answerElsewhere")
              : (status ?? "")}
      </p>

      {interactive ? (
        <>
          <RadioGroup
            className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5"
            value={choice}
            onValueChange={(v) => setChoice(v as ApprovalChoice)}
            aria-label={t("blocks.approval.decision")}
          >
            {offered.includes("once") ? <Choice value="once" label={scopeLabel("once")} /> : null}
            {offered.includes("task") ? <Choice value="task" label={scopeLabel("task")} /> : null}
            {offered.includes("site") && site !== null ? (
              <Choice value="site" label={scopeLabel("site")} hint={site} />
            ) : null}
            {hasAlways ? (
              <div className="flex items-center gap-2">
                <Choice value="always" label={scopeLabel("always")} />
                <label className="sr-only" htmlFor={`${headingId}-until`}>
                  {t("blocks.approval.alwaysUntil")}
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
                    <option value="session">{untilLabel("session")}</option>
                  ) : null}
                  {offered.includes("always") ? (
                    <option value="always">{untilLabel("always")}</option>
                  ) : null}
                </NativeSelect>
              </div>
            ) : null}
            <Choice value="deny" label={t("blocks.approval.deny")} />
          </RadioGroup>

          {approval.requiresAuthentication || otherSurfaces.length > 0 ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
              {approval.requiresAuthentication ? (
                <span className="inline-flex items-center gap-1.5">
                  <Fingerprint className="size-3.5" aria-hidden="true" />{" "}
                  {t("blocks.approval.needsAuth")}
                </span>
              ) : null}
              {otherSurfaces.length > 0 ? (
                <span>
                  {t("blocks.approval.alsoSentTo", { surfaces: otherSurfaces.join(", ") })}
                </span>
              ) : null}
            </p>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p className="mt-2 text-danger-text" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          className="-ms-1.5 text-muted-foreground"
          aria-expanded={showIds}
          aria-controls={`${headingId}-ids`}
          onClick={() => setShowIds((v) => !v)}
        >
          <ChevronRight
            className={cn("transition-transform", showIds ? "rotate-90" : "rtl:rotate-180")}
            aria-hidden="true"
          />
          {t("blocks.approval.details")}
        </Button>
        <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
          {t("blocks.approval.binding")}{" "}
          <span className="font-mono">{approval.bindingHash.slice(0, 15)}…</span>{" "}
          {t("blocks.approval.bindingVoids")}
        </p>
        {interactive ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <p id={hintId} className="text-caption text-muted-foreground">
              <kbd className="font-sans">⌘↩</kbd> {t("blocks.approval.keyAllows")} ·{" "}
              <kbd className="font-sans">⌘D</kbd> {t("blocks.approval.keyDenies")}
            </p>
            <Button
              variant="outline"
              disabled={!armed || busy}
              onClick={() => void submit("deny")}
              aria-keyshortcuts="Meta+D Control+D"
              aria-describedby={`${hintId}`}
            >
              {t("blocks.approval.deny")}
            </Button>
            <Button
              disabled={!armed || busy || choice === "deny"}
              onClick={(e) => {
                // Return and Space on this button never approve; only ⌘Return or a pointer does.
                if (e.detail === 0) return;
                void submit("approve");
              }}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-describedby={`${hintId}`}
            >
              {t("blocks.approval.allowWithScope")}
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
