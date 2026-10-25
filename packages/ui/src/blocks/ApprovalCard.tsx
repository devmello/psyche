import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { renderForSurface, sanitizeApproval } from "@psyche/permissions/cards";
import type { ApprovalRequest, GrantScope } from "@psyche/protocol";
import { CircleAlert, Ellipsis, Fingerprint, ShieldCheck } from "lucide-react";
import * as m from "motion/react-m";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatCountdown, formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { fade, motionSpring, spring } from "../motion/index.ts";
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
  /** Shared-layout id: the dock's card morphs into the transcript's result row (§5.3). */
  layoutId?: string;
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
  layoutId,
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

  const offeredScopes: { value: ApprovalChoice; short: string; long: string; hint?: string }[] = [
    ...(offered.includes("once")
      ? [{ value: "once" as const, short: scopeLabel("once"), long: scopeLabel("once") }]
      : []),
    ...(offered.includes("task")
      ? [
          {
            value: "task" as const,
            short: t("chat.approval.segment.task"),
            long: scopeLabel("task"),
          },
        ]
      : []),
    ...(offered.includes("site") && site !== null
      ? [
          {
            value: "site" as const,
            short: t("chat.approval.segment.site"),
            long: `${scopeLabel("site")} ${site}`,
            hint: site,
          },
        ]
      : []),
    ...(hasAlways
      ? [
          {
            value: "always" as const,
            short: t("chat.approval.segment.always"),
            long: scopeLabel("always"),
          },
        ]
      : []),
    { value: "deny", short: t("blocks.approval.deny"), long: t("blocks.approval.deny") },
  ];
  const canAllow = armed && !busy && choice !== "deny";
  const requester = t("blocks.approval.requester", {
    persona,
    hasTask: Boolean(taskTitle),
    task: taskTitle ?? "",
    hasFrom: Boolean(createdFrom),
    from: createdFrom ?? "",
    hasAgent: Boolean(approval.requestedBy.agent && approval.requestedBy.agent !== persona),
    agent: approval.requestedBy.agent ?? "",
  });

  return (
    <m.fieldset
      // Fades in place and out; never moves while shown (docs/06 §3.3, motion.md §3).
      {...fade}
      {...(layoutId
        ? {
            layoutId,
            transition: { layout: motionSpring(spring.emphasis), ...fade.animate.transition },
          }
        : {})}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      data-approval-id={approval.id}
      data-status={stale ? "stale" : expiredByClock ? "expired" : approval.status}
      className={cn(
        // Level 1 (redesign-2026 §5.3): raised surface, no outline; a 2 px amber leading edge
        // while it waits for an answer. It fades in place and never moves (docs/06 §3.3).
        "relative m-0 min-w-0 overflow-hidden rounded-lg bg-surface-raised p-4 ps-5 text-body text-label-primary shadow-elevation-1",
        className,
      )}
    >
      {pending && !stale ? (
        <span
          className="absolute inset-y-0 start-0 w-0.5 bg-approval"
          aria-hidden="true"
          data-testid="approval-edge"
        />
      ) : null}
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-approval-text" aria-hidden="true" />
        <span className="text-caption text-approval-text">
          {pending ? t("blocks.approval.titlePending") : t("blocks.approval.title")}
        </span>
        {pending ? (
          <span
            className={cn(
              "text-caption tabular-nums",
              remaining < 60_000 ? "text-danger-text" : "text-approval-text",
            )}
          >
            · {t("blocks.approval.expiresIn", { countdown: formatCountdown(remaining) })}
          </span>
        ) : null}
        <span className="ms-auto" />
        {/* Technical details (ids, hashes, the binding) are level 2, under ⋯ (§5.3). */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="-me-1.5 text-label-secondary"
                aria-label={t("chat.approval.more")}
              />
            }
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={showIds}
              onCheckedChange={(v) => setShowIds(Boolean(v))}
            >
              {t("blocks.approval.details")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-0.5 text-callout text-label-secondary" data-card-header>
        {header}
      </p>
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="mt-1 text-title-2 text-label-primary outline-none"
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

      {/* Who and why, as one secondary line (§5.3); the labels stay for screen readers. */}
      <p className="mt-2 text-callout text-label-secondary">
        <span className="sr-only">{t("blocks.approval.requestedBy")} </span>
        {requester}
        {why ? (
          <>
            {" · "}
            <span className="sr-only">{t("blocks.approval.whyAsked")} </span>
            {why}
          </>
        ) : null}
      </p>

      {/* Always mounted so screen readers announce the text when it appears (C7). */}
      <p
        className={
          status !== null || expiredByClock || stale || (pending && !canAnswer)
            ? "mt-3 rounded-md bg-fill-tertiary px-3 py-2 text-label-primary"
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* The scope is one segmented control; Deny is preselected (docs/06 §3.3). */}
            <RadioGroupPrimitive
              value={choice}
              onValueChange={(v) => setChoice(v as ApprovalChoice)}
              aria-label={t("blocks.approval.decision")}
              className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md bg-fill-secondary p-0.5"
            >
              {offeredScopes.map((scope) => (
                <RadioPrimitive.Root
                  key={scope.value}
                  value={scope.value}
                  aria-label={scope.long}
                  {...(scope.hint ? { title: scope.hint } : {})}
                  className={cn(
                    "relative inline-flex h-6 cursor-default items-center rounded-sm px-2.5 text-body outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) focus-visible:ring-2 focus-visible:ring-ring",
                    choice === scope.value
                      ? "text-label-primary"
                      : "text-label-secondary hover:text-label-primary",
                  )}
                >
                  {choice === scope.value ? (
                    <m.span
                      layoutId={`approval-scope-${approval.id}`}
                      transition={motionSpring(spring.micro)}
                      className="absolute inset-0 rounded-sm bg-surface-raised shadow-elevation-1"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="relative">{scope.short}</span>
                </RadioPrimitive.Root>
              ))}
            </RadioGroupPrimitive>
            {hasAlways ? (
              <>
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
              </>
            ) : null}
          </div>

          {approval.requiresAuthentication || otherSurfaces.length > 0 ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-callout text-label-secondary">
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
        <p className="mt-2 flex items-start gap-2 text-label-primary" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {interactive ? (
        // Deny leading, Allow trailing; the buttons never move (docs/06 §3.3).
        <div className="mt-4 flex items-center justify-end gap-2">
          <p id={hintId} className="sr-only">
            ⌘↩ {t("blocks.approval.keyAllows")} · ⌘D {t("blocks.approval.keyDenies")}
          </p>
          <Button
            variant="outline"
            disabled={!armed || busy}
            onClick={() => void submit("deny")}
            aria-keyshortcuts="Meta+D Control+D"
            aria-describedby={hintId}
          >
            {t("blocks.approval.deny")}
          </Button>
          <Button
            // Solid accent once armed; before that a fill with a 400 ms progress underline, so
            // it never reads as disabled for good (§5.3).
            variant={canAllow ? "default" : "secondary"}
            className="relative overflow-hidden"
            disabled={!canAllow}
            onClick={(e) => {
              // Return and Space on this button never approve; only ⌘Return or a pointer does.
              if (e.detail === 0) return;
              void submit("approve");
            }}
            aria-label={t("blocks.approval.allowWithScope")}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            aria-describedby={hintId}
          >
            {t("chat.approval.allow")}
            <kbd className="font-sans text-callout opacity-70">⌘↩</kbd>
            {!armed ? (
              <m.span
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent-9"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: armDelayMs / 1000, ease: "linear" }}
                aria-hidden="true"
                data-testid="approval-arming"
              />
            ) : null}
          </Button>
        </div>
      ) : null}
      {/* Below the buttons, so opening it never moves them (§3.3). */}
      {showIds ? (
        <div
          id={`${headingId}-ids`}
          className="mt-3 rounded-md bg-fill-quaternary px-3 py-2"
          data-testid="approval-ids"
        >
          <p className="mb-1 text-callout text-label-secondary">
            {t("blocks.approval.binding")}{" "}
            <span className="text-mono">{approval.bindingHash.slice(0, 15)}…</span>{" "}
            {t("blocks.approval.bindingVoids")}
          </p>
          <ApprovalIds approval={approval} />
        </div>
      ) : null}
    </m.fieldset>
  );
}
