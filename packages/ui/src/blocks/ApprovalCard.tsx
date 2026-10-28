import { renderForSurface, sanitizeApproval } from "@psyche/permissions/cards";
import type { ApprovalRequest, GrantScope, MissingPermission } from "@psyche/protocol";
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
import { easeLinear, fade, motionSpring, spring } from "../motion/index.ts";
import { useSlots } from "../slots.tsx";
import { roleLabel } from "../specialists/model.ts";
import { ApprovalDetails, ApprovalIds } from "./approval-details.tsx";
import { floorClassOf, useLiftFloorConfirm } from "./LiftFloorDialog.tsx";
import { taintSentence } from "./taint-text.ts";

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

type AllowScope = Exclude<ApprovalChoice, "deny">;

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
  /** A specialist's approval: the thread that started the job, for the card's context line. */
  parentThreadTitle?: string | null;
  /** Thread permission mode, for "Why asked". */
  mode?: string;
  /** Surface labels for "Also sent to" (other than this one). */
  otherSurfaces?: readonly string[];
  onAnswer?: (
    decision: "approve" | "deny",
    scope?: GrantScope,
    extras?: {
      folderPath?: string;
      unsandboxed?: "UNSANDBOXED";
      editedText?: string;
      recipientChoice?: string;
    },
  ) => unknown;
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

interface ComposeCard {
  account: string;
  text: string;
  recipientSource: "owner" | "untrusted";
  candidates: {
    id: string;
    kind: "handle" | "chat";
    label: string;
    service: string;
    weak: boolean;
    participants: string[];
  }[];
}

/** The `messages_send` compose details, or null for any other message_send card. */
function readComposeCard(details: unknown): ComposeCard | null {
  const c = (details as { compose?: unknown } | null)?.compose;
  if (typeof c !== "object" || c === null) return null;
  const v = c as Record<string, unknown>;
  if (!Array.isArray(v.candidates) || typeof v.text !== "string") return null;
  const candidates = v.candidates.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const r = x as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.label !== "string") return [];
    return [
      {
        id: r.id,
        kind: r.kind === "chat" ? ("chat" as const) : ("handle" as const),
        label: r.label,
        service: typeof r.service === "string" ? r.service : "unknown",
        weak: r.weak === true,
        participants: Array.isArray(r.participants)
          ? r.participants.filter((p): p is string => typeof p === "string")
          : [],
      },
    ];
  });
  if (candidates.length === 0) return null;
  return {
    account: typeof v.account === "string" ? v.account : "",
    // Details are display-sanitized: line breaks arrive as ⏎, so the editor restores them.
    text: v.text.replaceAll("⏎", "\n"),
    recipientSource: v.recipientSource === "untrusted" ? "untrusted" : "owner",
    candidates,
  };
}

const serviceLabel = (service: string): string =>
  service === "imessage"
    ? t("blocks.message.service.imessage")
    : service === "sms"
      ? t("blocks.message.service.sms")
      : service === "rcs"
        ? t("blocks.message.service.rcs")
        : t("blocks.message.service.unknown");

/** Who the message goes to (name, handle, service; a group's people) and the editable text. */
function MessageCompose({
  compose,
  recipientId,
  onRecipient,
  text,
  onText,
  labelId,
}: {
  compose: ComposeCard;
  recipientId: string;
  onRecipient: (id: string) => void;
  text: string;
  onText: (text: string) => void;
  labelId: string;
}): ReactElement {
  const many = compose.candidates.length > 1;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="message-compose">
      {compose.recipientSource === "untrusted" ? (
        <p className="text-callout text-danger-text" data-testid="message-untrusted">
          {t("blocks.message.untrusted")}
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-1" data-testid="message-recipients">
        <legend className="text-callout text-label-secondary">
          {many ? t("blocks.message.pick") : t("blocks.message.to")}
        </legend>
        {compose.candidates.map((c) => (
          <label
            key={c.id}
            className="flex items-start gap-2 rounded-md bg-fill-quaternary px-2 py-1.5 text-body"
          >
            <input
              type="radio"
              name={`${labelId}-recipient`}
              value={c.id}
              checked={recipientId === c.id}
              onChange={() => onRecipient(c.id)}
              className="mt-1"
            />
            <span className="min-w-0 flex-1 break-words">
              <span className="text-label-primary" data-testid="message-recipient">
                {c.label}
              </span>{" "}
              <span className="text-callout text-label-secondary">
                {c.kind === "chat"
                  ? t("blocks.message.group", { count: c.participants.length })
                  : serviceLabel(c.service)}
              </span>
              {c.weak ? (
                <span className="block text-callout text-danger-text">
                  {t("blocks.message.weak")}
                </span>
              ) : null}
              {c.participants.length > 0 ? (
                <span className="block text-callout text-label-secondary">
                  {c.participants.join(", ")}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <label
          id={labelId}
          htmlFor={`${labelId}-text`}
          className="text-callout text-label-secondary"
        >
          {t("blocks.message.text")}
        </label>
        <textarea
          id={`${labelId}-text`}
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={4}
          maxLength={20000}
          aria-label={t("blocks.message.textLabel")}
          className="min-h-20 w-full resize-y rounded-md bg-fill-secondary px-2 py-1.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-callout text-label-secondary">
          {text.trim() === "" ? t("blocks.message.empty") : t("blocks.message.exact")}
        </p>
      </div>
    </div>
  );
}

const scopeLabel = (scope: GrantScope): string => t(`blocks.approval.scope.${scope}`);

/** "Downloads" for `/Users/me/Downloads`. */
function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

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
  parentThreadTitle,
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
  // The scope sits on the Allow action; the narrowest offered lifetime is the default.
  const [choice, setChoice] = useState<AllowScope>(
    (["once", "task", "site", "session", "always"] as const).find((v) =>
      approval.scopesOffered.includes(v),
    ) ?? "once",
  );
  const [armed, setArmed] = useState(armDelayMs === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showIds, setShowIds] = useState(false);
  // folder_access: the folder the owner picks is what is granted, never the agent's string.
  const isFolder = raw.kind === "folder_access";
  const { pickFolder, permissionAction } = useSlots();
  // The Gateway resolved the path the agent named: a usable folder is pre-filled and is exactly
  // what is granted; a blocked or missing one needs the owner's pick.
  const requestedFolder =
    typeof raw.details.folderStatus === "string"
      ? {
          status: raw.details.folderStatus,
          path: typeof raw.details.resolvedPath === "string" ? raw.details.resolvedPath : "",
        }
      : null;
  const [folder, setFolder] = useState(
    requestedFolder?.status === "ok" ? requestedFolder.path : "",
  );
  const folderBlocked = requestedFolder?.status === "blocked" && folder === "";
  // message_send compose card (`messages_send`): the recipient picked and the text left in the
  // editor are what the Gateway binds and sends, not the agent's draft.
  const compose = useMemo(() => readComposeCard(raw.details), [raw.details]);
  const [recipientId, setRecipientId] = useState(
    compose?.candidates.length === 1 ? (compose.candidates[0]?.id ?? "") : "",
  );
  const [messageText, setMessageText] = useState(compose?.text ?? "");
  // exec_host (security §5.4): srt unless the owner types the word, which allows this run only.
  const rawDetails = raw.details as Record<string, unknown>;
  const isExecHost = raw.kind === "exec_host";
  const unsandboxedWord =
    typeof rawDetails.unsandboxedWord === "string" ? rawDetails.unsandboxedWord : "UNSANDBOXED";
  // Set up from this card's "Set up sandbox": the run re-resolves srt, so the card follows.
  const [sandboxSetUp, setSandboxSetUp] = useState(false);
  const sandboxReady = rawDetails.sandbox === "srt" || sandboxSetUp;
  const [typed, setTyped] = useState("");
  const unsandboxed = isExecHost && typed === unsandboxedWord;
  // permission_request (§3.13): Enable turns a setting on; the rest are fixed elsewhere, then checked.
  const isPermission = raw.kind === "permission_request";
  const need = (isPermission ? rawDetails.need : undefined) as MissingPermission | undefined;
  const enables = need?.need === "capability" || need?.need === "connector_action";

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
  // A send / destructive / financial card (§3.12): Always allow lifts its floor for this call
  // class, so it confirms first, and a tainted one never offers it (§3.6).
  const floor = floorClassOf(approval.kind, approval.sideEffect);
  const offered =
    floor !== null && approval.taint
      ? approval.scopesOffered.filter((s) => s === "once")
      : approval.scopesOffered;
  const liftConfirm = useLiftFloorConfirm(persona, "card");

  const submit = async (decision: "approve" | "deny", confirmed = false) => {
    if (!interactive || !armed || busy) return;
    if (decision === "approve" && !allowReady) return;
    if (decision === "approve" && floor !== null && choice === "always" && !confirmed) {
      liftConfirm.ask(
        floor,
        t("blocks.liftFloor.cardWhat", { summary: approval.summary }),
        () => void submit("approve", true),
      );
      return;
    }
    const scope: GrantScope | undefined = decision === "deny" ? undefined : choice;
    setBusy(true);
    setError(null);
    try {
      // macOS access: re-read the grant first, so the Gateway's check sees what was just allowed.
      if (decision === "approve" && need?.need === "macos_access") {
        await permissionAction?.(need, "check");
      }
      await onAnswer?.(
        decision,
        unsandboxed && scope !== undefined ? "once" : scope,
        compose !== null && decision === "approve"
          ? { editedText: messageText, recipientChoice: recipientId }
          : isFolder && decision === "approve" && folder !== ""
            ? { folderPath: folder }
            : unsandboxed && decision === "approve"
              ? { unsandboxed: "UNSANDBOXED" }
              : undefined,
      );
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
      void submit("approve");
    } else if (e.key.toLowerCase() === "d") {
      e.preventDefault();
      void submit("deny");
    }
  };

  const status = statusText(approval, now);
  const whatLabel = t("blocks.approval.whatItWillDo");
  const onlyOnce = offered.length === 1 && offered[0] === "once";
  const taintNote = pending ? taintSentence(approval, persona, onlyOnce) : null;
  // The Broker's own reason when the Gateway sends one (docs/archive/status/s12.md, gap 3).
  const reason = (approval.details as Record<string, unknown>).reason;
  // The folder and permission cards already show the reason in their own "Why" row.
  const reasonInDetails = isFolder || isPermission;
  const why = reasonInDetails
    ? ""
    : typeof reason === "string" && reason.trim() !== ""
      ? reason
      : [mode ? t("blocks.approval.modeReason", { mode }) : null, approval.sideEffect ?? null]
          .filter(Boolean)
          .join("; ");

  const permissionLabel = enables
    ? t("blocks.permission.enable")
    : t("blocks.permission.checkAgain");
  const offeredScopes: { value: AllowScope; label: string }[] = [
    ...(offered.includes("once")
      ? [{ value: "once" as const, label: isPermission ? permissionLabel : scopeLabel("once") }]
      : []),
    ...(offered.includes("task") ? [{ value: "task" as const, label: scopeLabel("task") }] : []),
    ...(offered.includes("site") && site !== null
      ? [{ value: "site" as const, label: `${scopeLabel("site")} ${site}` }]
      : []),
    // Typing UNSANDBOXED allows this run only, so no lasting scope is offered then.
    ...(offered.includes("session") && !unsandboxed
      ? [{ value: "session" as const, label: scopeLabel("session") }]
      : []),
    ...(offered.includes("always") && !unsandboxed
      ? [
          {
            value: "always" as const,
            // A batch card offers `always` only for the prep note (security §3.4): name what it covers.
            label:
              approval.kind === "batch"
                ? t("blocks.approval.scope.prepNotes")
                : scopeLabel("always"),
          },
        ]
      : []),
  ];
  const allowReady =
    offeredScopes.length > 0 &&
    (!isFolder || folder !== "") &&
    (compose === null || (recipientId !== "" && messageText.trim() !== "")) &&
    (!isExecHost || sandboxReady || unsandboxed);
  const canAllow = armed && !busy && allowReady;
  const specialist = approval.requestedBy.specialist;
  // A specialist asks (specialists §4.4): "For {task} · Shopper started by Psyche in Main chat".
  const requester = specialist
    ? t("blocks.approval.specialist", {
        hasTask: Boolean(taskTitle),
        task: taskTitle ?? "",
        role: roleLabel(specialist),
        agent: persona,
        hasThread: Boolean(parentThreadTitle),
        thread: parentThreadTitle ?? "",
      })
    : t("blocks.approval.requester", {
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

      {interactive && isFolder ? (
        <div className="mt-2 flex flex-col gap-1.5" data-testid="folder-pick">
          <div className="grid grid-cols-[7rem_1fr] gap-3 py-0.5 text-body">
            <span
              className="text-callout leading-[18px] text-label-secondary"
              id={`${headingId}-folder-label`}
            >
              {t("blocks.folder.title")}
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {pickFolder ? (
                <>
                  <div className="min-w-0 flex-1">
                    {folder !== "" ? (
                      <>
                        <p className="truncate text-label-primary" data-testid="folder-name">
                          {folderName(folder)}
                        </p>
                        <p
                          className="break-all text-callout text-label-secondary"
                          data-testid="folder-picked"
                        >
                          {folder}
                        </p>
                      </>
                    ) : folderBlocked ? (
                      <p className="text-danger-text" data-testid="folder-blocked">
                        {t("blocks.folder.blocked", { path: requestedFolder?.path ?? "" })}
                      </p>
                    ) : (
                      <p className="text-label-primary" data-testid="folder-missing">
                        {requestedFolder?.status === "missing"
                          ? t("blocks.folder.notFound", {
                              path: String(raw.details.requestedPath ?? ""),
                            })
                          : t("blocks.folder.mustPick")}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      pickFolder({ title: t("blocks.folder.pickTitle", { persona }) }).then(
                        (picked) => {
                          if (picked !== null) setFolder(picked);
                        },
                        (err) =>
                          setError(t("blocks.folder.pickError", { error: describeError(err) })),
                      );
                    }}
                  >
                    {folder === "" ? t("blocks.folder.choose") : t("blocks.folder.change")}
                  </Button>
                </>
              ) : (
                // No native picker (a browser): the owner confirms the path by typing it.
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {folderBlocked ? (
                    <p className="text-danger-text" data-testid="folder-blocked">
                      {t("blocks.folder.blocked", { path: requestedFolder?.path ?? "" })}
                    </p>
                  ) : null}
                  <input
                    id={`${headingId}-folder`}
                    value={folder}
                    onChange={(e) => setFolder(e.target.value.trim())}
                    aria-label={t("blocks.folder.pathLabel")}
                    placeholder="/"
                    className="h-7 min-w-0 flex-1 rounded-md bg-fill-secondary px-2 text-callout outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              )}
            </div>
          </div>
          <p className="text-callout text-label-secondary">
            {t("blocks.folder.exact")} {t("blocks.folder.scope")}
          </p>
        </div>
      ) : null}

      {interactive && compose !== null ? (
        <MessageCompose
          compose={compose}
          recipientId={recipientId}
          onRecipient={setRecipientId}
          text={messageText}
          onText={setMessageText}
          labelId={`${headingId}-message`}
        />
      ) : null}

      {interactive && isExecHost ? (
        <div className="mt-3 flex flex-col gap-1.5" data-testid="exec-host-sandbox">
          <p
            className={cn(
              "text-callout",
              sandboxReady ? "text-label-secondary" : "text-danger-text",
            )}
          >
            {sandboxReady
              ? t("blocks.execHost.sandboxed", { word: unsandboxedWord })
              : t("blocks.execHost.noSandbox", { word: unsandboxedWord })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={typed}
              onChange={(e) => {
                const v = e.target.value.trim();
                setTyped(v);
                if (v === unsandboxedWord && choice === "always") setChoice("once");
              }}
              aria-label={t("blocks.execHost.typeLabel", { word: unsandboxedWord })}
              placeholder={unsandboxedWord}
              autoComplete="off"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md bg-fill-secondary px-2 font-mono text-callout outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {!sandboxReady && permissionAction ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  Promise.resolve(permissionAction({ need: "sandbox" }, "open")).then(
                    (ready) => {
                      if (ready === true) setSandboxSetUp(true);
                    },
                    (err: unknown) => setError(describeError(err)),
                  );
                }}
              >
                {t("blocks.execHost.setUp")}
              </Button>
            ) : null}
          </div>
          {unsandboxed ? (
            <p className="text-callout text-label-secondary">
              {t("blocks.execHost.unsandboxedOnce")}
            </p>
          ) : !sandboxReady ? (
            <p className="text-callout text-label-secondary">
              {t("blocks.execHost.mustType", { word: unsandboxedWord })}
            </p>
          ) : null}
        </div>
      ) : null}

      {interactive && isPermission && need !== undefined ? (
        <div className="mt-3 flex flex-col gap-1.5" data-testid="permission-request">
          <p className="text-callout text-label-secondary">
            {enables ? t("blocks.permission.enableHint") : t("blocks.permission.checkHint")}
          </p>
          {!enables && permissionAction ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  Promise.resolve(permissionAction(need, "open")).catch((err: unknown) =>
                    setError(describeError(err)),
                  );
                }}
              >
                {need.need === "macos_access"
                  ? t("blocks.permission.openSystemSettings")
                  : need.need === "sandbox"
                    ? t("blocks.permission.setUpSandbox")
                    : t("blocks.permission.openConnectors")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {taintNote ? (
        <p className="mt-3 text-callout text-label-secondary" data-testid="taint-note">
          {taintNote}
        </p>
      ) : null}

      {interactive && (approval.requiresAuthentication || otherSurfaces.length > 0) ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-callout text-label-secondary">
          {approval.requiresAuthentication ? (
            <span className="inline-flex items-center gap-1.5">
              <Fingerprint className="size-3.5" aria-hidden="true" />{" "}
              {t("blocks.approval.needsAuth")}
            </span>
          ) : null}
          {otherSurfaces.length > 0 ? (
            <span>{t("blocks.approval.alsoSentTo", { surfaces: otherSurfaces.join(", ") })}</span>
          ) : null}
        </p>
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
            {t("chat.approval.keysHint", {
              allows: t("blocks.approval.keyAllows"),
              denies: t("blocks.approval.keyDenies"),
            })}
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
          {offeredScopes.length > 1 ? (
            <>
              <label className="sr-only" htmlFor={`${headingId}-scope`}>
                {t("blocks.approval.allowScope")}
              </label>
              <NativeSelect
                id={`${headingId}-scope`}
                size="sm"
                value={choice}
                disabled={busy}
                onChange={(e) => setChoice(e.target.value as AllowScope)}
              >
                {offeredScopes.map((scope) => (
                  <option key={scope.value} value={scope.value}>
                    {scope.label}
                  </option>
                ))}
              </NativeSelect>
            </>
          ) : null}
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
            {isPermission ? permissionLabel : t("chat.approval.allow")}
            <kbd className="font-sans text-callout opacity-70">⌘↩</kbd>
            {!armed ? (
              <m.span
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent-9"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: armDelayMs / 1000, ease: easeLinear }}
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
      {liftConfirm.dialog}
    </m.fieldset>
  );
}
