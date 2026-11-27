import { approvalCode, renderForSurface, sanitizeApproval } from "@psyche/permissions/cards";
import type { ApprovalRequest, GrantScope, MissingPermission } from "@psyche/protocol";
import { CircleAlert, Ellipsis, Fingerprint, ShieldCheck } from "lucide-react";
import * as m from "motion/react-m";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
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
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatRelative, formatTime } from "../lib/format.ts";
import { keysLabel } from "../lib/keys.ts";
import { pathBasename } from "../lib/paths.ts";
import { isMac } from "../lib/platform.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { easeLinear, fade, motionSpring, spring } from "../motion/index.ts";
import { useSlots } from "../slots.tsx";
import { roleLabel } from "../specialists/model.ts";
import {
  type AnswerFailure,
  answerFailureText,
  classifyAnswerError,
  type TouchIdFix,
} from "./answer-error.ts";
import {
  type AllowScope,
  answerFor,
  cardChoices,
  cardOffered,
  defaultAllow,
  spaceOffer,
} from "./approval-choice.ts";
import { ApprovalDetails, ApprovalIds } from "./approval-details.tsx";
import { plainHeader, plainReason, plainTitle, voidedText } from "./approval-plain.ts";
import { otherSurfacesFor } from "./approval-surfaces.ts";
import { floorClassOf, useLiftFloorConfirm } from "./LiftFloorDialog.tsx";
import { approvalMachineLine } from "./machine-line.ts";
import { taintSentence } from "./taint-text.ts";

/** The approve chord on the button: the compact ⌘↩ on macOS, "Ctrl+Enter" elsewhere. */
const approveKeys = (): string => (isMac() ? "⌘↩" : keysLabel("Mod+Enter"));

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
      /** `folder_access`: grant read-only although the agent asked to change files. */
      folderMode?: "ro";
      unsandboxed?: "UNSANDBOXED";
      editedText?: string;
      recipientChoice?: string;
      /** "Always for this site" on a first-read card (sent with scope `once`). */
      trustSite?: "origin" | "subdomains";
      /** "Always allow <program> in <folder>" on a host-command card (sent with scope `once`). */
      hostProgram?: true;
      /** "Allow in this Space" on a folder card that offers it (sent with scope `once`). */
      inSpace?: true;
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

/** "Downloads" for `/Users/me/Downloads` or `C:\Users\me\Downloads`. */
const folderName = pathBasename;

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
      if (approval.invalidatedReason === "owner_replied_in_chat") {
        return t("blocks.approval.status.declinedInChat");
      }
      return t("blocks.approval.status.denied", {
        hasWhen: Boolean(approval.decidedAt),
        when: approval.decidedAt ? formatRelative(approval.decidedAt, now) : "",
      });
    case "expired":
      return t("approvals.expired");
    case "invalidated":
      return voidedText(approval.invalidatedReason);
    default:
      return null;
  }
}

/**
 * A height-capped field list. While more rows sit below the fold the bottom edge fades out (the
 * app's scroll-edge), so a cut line never reads as the end of the list.
 */
function CappedDetails({
  className,
  label,
  children,
}: {
  className: string;
  label: string;
  children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);
  return (
    <section
      ref={ref}
      className={cn("mt-2", className)}
      style={more ? { maskImage: "linear-gradient(to top, transparent 0, black 24px)" } : undefined}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a capped region must scroll by keyboard
      tabIndex={0}
    >
      {children}
    </section>
  );
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
  otherSurfaces: allOtherSurfaces = [],
  onAnswer,
  now: fixedNow,
  autoFocus = false,
  armDelayMs = 400,
  className,
  detailsClassName,
  layoutId,
}: ApprovalCardProps): ReactElement {
  const approval = useMemo(() => sanitizeApproval(raw), [raw]);
  // A paired phone's own `device:<deviceId>` surface is not a place to name: hide it.
  const otherSurfaces = useMemo(() => otherSurfacesFor(allOtherSurfaces, []), [allOtherSurfaces]);
  // What the action does in plain words: side effect · taint (never attacker text).
  const header = useMemo(
    () =>
      plainHeader(
        raw,
        plainTitle(sanitizeApproval(raw), "") === null
          ? (renderForSurface("desktop", raw).text.split("\n")[0] ?? "")
          : null,
      ),
    [raw],
  );
  // "Wren wants to run `npm install` in psyche": the heading for a command or a file save. The
  // rows below always stay open (commands are shown in full). Null (a long command, a patch, any
  // other kind): the Gateway's summary and its kind title.
  const sentence = useMemo(() => plainTitle(approval, persona), [approval, persona]);
  const machineLine = approvalMachineLine(approval);
  // No ticking clock (S35): the card reads the time once and re-renders a single time, when the
  // approval expires, so it stops offering buttons the Gateway would refuse.
  const [clockNow, setClockNow] = useState(() => fixedNow ?? Date.now());
  const now = fixedNow ?? clockNow;
  useEffect(() => {
    if (fixedNow !== undefined || approval.status !== "pending") return;
    const wait = Date.parse(approval.expiresAt) - Date.now();
    if (!Number.isFinite(wait)) return;
    if (wait <= 0) {
      setClockNow(Date.now());
      return;
    }
    // setTimeout cannot wait longer than 2^31 - 1 ms; a farther expiry just re-checks then.
    const timer = setTimeout(() => setClockNow(Date.now()), Math.min(wait, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [fixedNow, approval.status, approval.expiresAt]);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Allow sends the narrowest offered lifetime; the second choice and "More options" send theirs.
  const allowValue = defaultAllow(approval);
  const [moreOpen, setMoreOpen] = useState(false);
  // An answer that made a lasting grant offers to take it back (`grants.revoke`).
  const call = useCall();
  const [undo, setUndo] = useState<"idle" | "busy" | "done">("idle");
  const [undoError, setUndoError] = useState<string | null>(null);
  const [armed, setArmed] = useState(armDelayMs === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A rate-limited answer disables Allow until the Gateway's retry-after has passed.
  const [limitedUntil, setLimitedUntil] = useState<number | null>(null);
  const [limitFailure, setLimitFailure] = useState<AnswerFailure | null>(null);
  // Touch ID could not confirm from this window: the fix the card offers (start the helper, set
  // up the key), then Allow asks Touch ID again.
  const [touchIdFixFor, setTouchIdFixFor] = useState<TouchIdFix | null>(null);
  // Synchronous guard: two clicks in one tick must send one answer.
  const inFlight = useRef(false);
  const [showIds, setShowIds] = useState(false);
  // folder_access: the folder the owner picks is what is granted, never the agent's string.
  // separate_desktop_share is the same pick for the Linux separate desktop, and grants nothing here.
  const isSdShare = raw.kind === "separate_desktop_share";
  const isFolder = raw.kind === "folder_access" || isSdShare;
  const {
    pickFolder,
    permissionAction,
    touchIdFix,
    touchIdOnceOnly,
    passwordPresence,
    remotePresence,
  } = useSlots();
  // Linux: Allow opens the system's own password dialog; the card says so while it is up.
  const [waitingForPassword, setWaitingForPassword] = useState(false);
  // A remote client with no passkey of its own can't give the presence this card needs.
  const answerOnHost =
    remotePresence !== undefined && approval.requiresAuthentication && !remotePresence.hasPasskey
      ? remotePresence.hostName
      : null;
  // Touch ID from this window approves once only (security §3.7): say so, never drop "Always"
  // silently.
  const onceOnlyHere = touchIdOnceOnly === true && approval.requiresAuthentication;
  const [forcedOnce, setForcedOnce] = useState(false);
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
  // The agent asked to change files: the owner may narrow that to read-only (never the reverse).
  const asksWrite = isFolder && raw.details.access === "rw";
  const [readOnly, setReadOnly] = useState(false);
  // message_send compose card (`messages_send`): the recipient picked and the text left in the
  // editor are what the Gateway binds and sends, not the agent's draft.
  const compose = useMemo(() => readComposeCard(raw.details), [raw.details]);
  const [recipientId, setRecipientId] = useState(
    compose?.candidates.length === 1 ? (compose.candidates[0]?.id ?? "") : "",
  );
  const [messageText, setMessageText] = useState(compose?.text ?? "");
  // exec_host (security §5.4): srt unless the owner taps "Run once without the sandbox".
  const rawDetails = raw.details as Record<string, unknown>;
  const isExecHost = raw.kind === "exec_host";
  // Set up from this card's "Set up sandbox": the run re-resolves srt, so the card follows.
  const [sandboxSetUp, setSandboxSetUp] = useState(false);
  const sandboxReady = rawDetails.sandbox === "srt" || sandboxSetUp;
  // Windows: no sandbox exists for commands on the PC itself, so there is nothing to set up.
  const noHostSandbox = rawDetails.hostSandbox === "none";
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
  const expired = expiredByClock || approval.status === "expired";
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
  const inSpaceOffer = approval.status === "pending" ? spaceOffer(approval) : null;
  // A send / destructive / financial card (§3.12): Always allow lifts its floor for this call
  // class, so it confirms first, and a tainted one never offers it (§3.6).
  const floor = floorClassOf(approval.kind, approval.sideEffect);
  const offered = cardOffered(approval);
  const liftConfirm = useLiftFloorConfirm(persona, "card");

  const submit = async (
    decision: "approve" | "deny",
    confirmed = false,
    pick: AllowScope = allowValue,
    // The "Run once without the sandbox" button (security §5.4): one command, once, no grant.
    viaUnsandboxed = false,
  ) => {
    const unsandboxed = viaUnsandboxed && isExecHost;
    if (!interactive || !armed || busy || inFlight.current) return;
    if (limitedUntil !== null && Date.now() < limitedUntil && decision === "approve") return;
    if (
      decision === "approve" &&
      (!(unsandboxed ? allowBase : allowReady) || answerOnHost !== null)
    )
      return;
    if (decision === "approve" && floor !== null && pick === "always" && !confirmed) {
      liftConfirm.ask(
        floor,
        t("blocks.liftFloor.cardWhat", { summary: approval.summary }),
        () => void submit("approve", true, pick),
      );
      return;
    }
    const sent = answerFor(pick);
    const extra = decision === "approve" ? sent.extras : undefined;
    const trustSite = extra !== undefined && "trustSite" in extra ? extra.trustSite : undefined;
    const hostProgram = extra !== undefined && "hostProgram" in extra;
    const inSpace = decision === "approve" && pick === "space" && inSpaceOffer !== null;
    const scope: GrantScope | undefined = decision === "deny" ? undefined : sent.scope;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setLimitedUntil(null);
    setLimitFailure(null);
    setTouchIdFixFor(null);
    setWaitingForPassword(
      decision === "approve" && passwordPresence === true && approval.requiresAuthentication,
    );
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
            ? {
                folderPath: folder,
                ...(asksWrite && readOnly ? { folderMode: "ro" as const } : {}),
                ...(inSpace ? { inSpace: true as const } : {}),
              }
            : unsandboxed && decision === "approve"
              ? { unsandboxed: "UNSANDBOXED" }
              : trustSite !== undefined
                ? { trustSite }
                : hostProgram
                  ? { hostProgram: true as const }
                  : undefined,
      );
      if (decision === "approve" && onceOnlyHere && scope !== undefined && scope !== "once") {
        setForcedOnce(true);
      }
    } catch (err) {
      const failure = classifyAnswerError(err);
      if (failure.kind === "rate_limited") {
        setLimitedUntil(Date.now() + failure.retryAfterSec * 1000);
        setLimitFailure(failure);
        setError(null);
      } else if (failure.kind === "cancelled") {
        // The owner cancelled the system sheet: not approved, and the card just stays as it was.
        setError(null);
      } else {
        setError(answerFailureText(failure));
        if (failure.kind === "touch_id_setup") setTouchIdFixFor(failure.fix);
      }
    } finally {
      inFlight.current = false;
      setWaitingForPassword(false);
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

  const status =
    forcedOnce && approval.status === "approved"
      ? passwordPresence === true
        ? t("blocks.approval.status.allowedOncePassword")
        : t("blocks.approval.status.allowedOnceTouchId")
      : statusText(approval, now);
  const grantedScope =
    approval.status === "approved" && approval.grantId != null && approval.scopeGranted
      ? approval.scopeGranted
      : null;
  const undoable = grantedScope !== null && grantedScope !== "once" && !forcedOnce;
  const undoGrant = async () => {
    if (!undoable || approval.grantId == null || undo !== "idle") return;
    setUndo("busy");
    setUndoError(null);
    try {
      await call("grants.revoke", { grantId: approval.grantId });
      setUndo("done");
    } catch (err) {
      setUndo("idle");
      setUndoError(t("actionError.revokeGrant", { reason: describeError(err) }));
    }
  };
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
      ? (plainReason(reason) ?? reason)
      : mode && approval.sideEffect
        ? t("blocks.approval.whyMode", {
            mode: mode.charAt(0).toUpperCase() + mode.slice(1),
            effect: t(`blocks.approval.sideEffect.${approval.sideEffect}`),
          })
        : [
            mode ? t("blocks.approval.modeReason", { mode }) : null,
            approval.sideEffect ? t(`blocks.approval.sideEffect.${approval.sideEffect}`) : null,
          ]
            .filter(Boolean)
            .join("; ");

  const permissionLabel = enables
    ? t("blocks.permission.enable")
    : t("blocks.permission.checkAgain");
  const {
    allow: allowChoice,
    second,
    more,
  } = cardChoices(approval, {
    site,
    folderWords: isFolder,
    sdShare: isSdShare,
    onceOnly: onceOnlyHere,
    ...(isPermission ? { permissionLabel } : {}),
  });
  const allowLabel = isPermission
    ? permissionLabel
    : allowChoice !== null && allowChoice.value !== "once"
      ? allowChoice.label
      : t("chat.approval.allow");
  const allowBase =
    allowChoice !== null &&
    (!isFolder || folder !== "") &&
    (compose === null || (recipientId !== "" && messageText.trim() !== ""));
  const allowReady = allowBase && (!isExecHost || sandboxReady);
  // The countdown runs only while the Gateway has the owner rate-limited.
  const limitNow = useNow(1000, undefined, limitedUntil !== null);
  const limitSecondsLeft =
    limitedUntil === null ? 0 : Math.max(0, Math.ceil((limitedUntil - limitNow) / 1000));
  const limited = limitSecondsLeft > 0;
  const canAllow = armed && !busy && allowReady && !limited && answerOnHost === null;
  const canRunUnsandboxed = armed && !busy && allowBase && !limited && answerOnHost === null;
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

  // An expired card is one muted line: nothing was done, nothing to answer, no timer.
  if (expired)
    return (
      <p
        className="m-0 px-1 text-callout text-label-secondary"
        data-approval-id={approval.id}
        data-status="expired"
        data-testid="approval-expired"
        role="status"
      >
        {t("blocks.approval.expiredLine")}
      </p>
    );

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
        // Level 1 (redesign-2026 §5.3): raised surface with a 1 px amber hairline while it waits
        // for an answer. It fades in place and never moves (docs/06 §3.3).
        "relative m-0 min-w-0 overflow-hidden rounded-lg border bg-surface-raised p-4 text-body text-label-primary shadow-elevation-1",
        pending && !stale ? "border-approval-border" : "border-transparent",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
        <span className="text-caption text-label-secondary">
          {pending ? t("blocks.approval.titlePending") : t("blocks.approval.title")}
        </span>
        {pending ? (
          <span className="text-caption tabular-nums text-label-secondary">
            · {t("simplify.b9.approval.expiresAt", { time: formatTime(approval.expiresAt) })}
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
      {machineLine ? (
        <p className="mt-0.5 text-callout font-medium text-label-primary" data-card-machine>
          {machineLine}
        </p>
      ) : null}
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="mt-1 text-title-2 text-label-primary outline-none [overflow-wrap:anywhere]"
      >
        {sentence ?? approval.summary}
      </h3>
      <p className="mt-0.5 text-callout text-label-secondary" data-card-header>
        {header}
      </p>

      {detailsClassName ? (
        <CappedDetails className={detailsClassName} label={whatLabel}>
          <ApprovalDetails approval={approval} persona={persona} />
        </CappedDetails>
      ) : (
        <div className="mt-2">
          <ApprovalDetails approval={approval} persona={persona} />
        </div>
      )}

      {/*
        Who and why, as one secondary line (§5.3); the labels stay for screen readers. It opens
        the card's evidence footer: one hairline, then the provenance lines close together.
      */}
      <p className="mt-3 border-t-[0.5px] border-separator-strong pt-3 text-callout text-label-secondary">
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
      {approval.setAside === true ? (
        // Nothing waits on a set-aside card: approving starts a resume run (deferred-resume.ts).
        <p className="mt-2 text-callout text-label-secondary" data-testid="approval-set-aside">
          {approval.status === "approved"
            ? t("agent.approvals.setAsideApproved")
            : t("agent.approvals.setAsideNote")}
        </p>
      ) : null}

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
            ? t("approvals.expired")
            : pending && !canAnswer
              ? t("blocks.approval.answerElsewhere")
              : undoable
                ? undo === "done"
                  ? t("approvals.undo.done")
                  : t(`approvals.undo.${grantedScope ?? "always"}`)
                : (status ?? "")}
        {undoable && undo !== "done" ? (
          <>
            {" · "}
            <button
              type="button"
              disabled={undo === "busy"}
              onClick={() => void undoGrant()}
              className="rounded-sm text-accent-11 underline outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              data-testid="approval-undo"
            >
              {t("approvals.undo.button")}
            </button>
          </>
        ) : null}
      </p>
      {undoError !== null ? (
        <p role="alert" className="mt-1 text-callout text-danger-text">
          {undoError}
        </p>
      ) : null}

      {interactive && isFolder ? (
        <div className="mt-2 flex flex-col gap-1.5" data-testid="folder-pick">
          <p className="text-body text-label-primary" data-testid="folder-explain">
            {t(
              isSdShare
                ? asksWrite
                  ? "blocks.folder.sd.explain.rw"
                  : "blocks.folder.sd.explain.ro"
                : asksWrite
                  ? "blocks.folder.explain.rw"
                  : "blocks.folder.explain.ro",
              { persona },
            )}
          </p>
          <div className="grid grid-cols-[7rem_1fr] gap-3 py-0.5 text-body">
            <span
              className="text-callout leading-5 text-label-secondary"
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
          {asksWrite ? (
            <label className="flex items-center gap-2 text-callout text-label-primary">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
                data-testid="folder-read-only"
              />
              {t("blocks.folder.readOnly")}
            </label>
          ) : null}
          <p className="text-callout text-label-secondary">
            {t("blocks.folder.exact")}{" "}
            {t(isSdShare ? "blocks.folder.sd.scope" : "blocks.folder.scope")}
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
              ? t("simplify.b9.execHost.sandboxed")
              : noHostSandbox
                ? t("simplify.b9.execHost.noHostSandbox")
                : t("simplify.b9.execHost.noSandbox")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!sandboxReady && !noHostSandbox && permissionAction ? (
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
            <Button
              variant="outline"
              size="sm"
              disabled={!canRunUnsandboxed}
              onClick={() => void submit("approve", false, "once", true)}
            >
              {t("simplify.b9.execHost.runOnce")}
            </Button>
          </div>
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
        <p className="mt-1 text-callout text-label-secondary" data-testid="taint-note">
          {taintNote}
        </p>
      ) : null}

      {interactive && (approval.requiresAuthentication || otherSurfaces.length > 0) ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-callout text-label-secondary">
          {approval.requiresAuthentication ? (
            <span className="inline-flex items-center gap-1.5">
              <Fingerprint className="size-3.5" aria-hidden="true" />{" "}
              {passwordPresence === true
                ? t("blocks.approval.password.needsAuth")
                : t("blocks.approval.needsAuth")}
              {/* The Touch ID sheet names the same code (security §3.7). */}
              <span className="font-mono" data-testid="approval-code">
                {t("blocks.approval.touchId.code", { code: approvalCode(approval.bindingHash) })}
              </span>
            </span>
          ) : null}
          {answerOnHost !== null ? (
            <span data-testid="answer-on-host">
              {t("blocks.approval.answerOnHost", { host: answerOnHost })}
            </span>
          ) : null}
          {onceOnlyHere && allowValue !== "once" ? (
            <span data-testid="touch-id-once-only">
              {passwordPresence === true
                ? t("blocks.approval.password.onceOnly")
                : t("blocks.approval.touchId.onceOnly")}
            </span>
          ) : null}
          {otherSurfaces.length > 0 ? (
            <span>{t("blocks.approval.alsoSentTo", { surfaces: otherSurfaces.join(", ") })}</span>
          ) : null}
        </p>
      ) : null}

      {waitingForPassword ? (
        // The system dialog's text is fixed and cannot name the approval, so Psyche's own window
        // says what the password is for (linux design §9.4).
        <p className="mt-2 flex flex-col gap-0.5" role="status" data-testid="password-waiting">
          <span className="text-label-primary">
            {t("blocks.approval.password.waiting", { code: approvalCode(approval.bindingHash) })}
          </span>
          <span className="text-callout text-label-secondary">
            {t("blocks.approval.password.waitingShort")}
          </span>
        </p>
      ) : null}

      {limited && limitFailure !== null ? (
        <p className="mt-2 flex items-start gap-2 text-label-primary" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
          {answerFailureText(limitFailure, limitSecondsLeft)}
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 flex items-start gap-2 text-label-primary" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {interactive && error && touchIdFixFor !== null && touchIdFix ? (
        <div className="mt-2" data-testid="touch-id-fix">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              const fix = touchIdFixFor;
              setBusy(true);
              touchIdFix(fix).then(
                () => {
                  // Never approves on its own: the owner clicks Allow again.
                  setBusy(false);
                  setError(null);
                  setTouchIdFixFor(null);
                },
                (err: unknown) => {
                  setBusy(false);
                  setError(describeError(err));
                },
              );
            }}
          >
            {touchIdFixFor === "start_helper"
              ? t("blocks.approval.touchId.startHelper")
              : touchIdFixFor === "restart_helper"
                ? t("blocks.approval.touchId.restartHelper")
                : t("blocks.approval.touchId.openDevices")}
          </Button>
        </div>
      ) : null}

      {interactive ? (
        // Deny leading, Allow trailing; the buttons never move (docs/06 §3.3). A lasting choice
        // sits between them, named by what it covers.
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
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
          {second !== null ? (
            <Button
              variant="outline"
              disabled={!canAllow}
              onClick={() => void submit("approve", false, second.value)}
              data-testid="approval-second-choice"
            >
              {second.label}
            </Button>
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
            aria-label={allowLabel}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            aria-describedby={hintId}
          >
            {allowLabel}
            <kbd className="font-sans text-callout opacity-85">{approveKeys()}</kbd>
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
      {/* Below the buttons, so opening it never moves them (§3.3): the rest of what is offered. */}
      {interactive && more.length > 0 ? (
        <div className="mt-2 flex flex-col items-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="text-label-secondary"
            aria-expanded={moreOpen}
            aria-controls={`${headingId}-more`}
            onClick={() => setMoreOpen((v) => !v)}
          >
            {t("approvals.more")}
          </Button>
          {moreOpen ? (
            <ul id={`${headingId}-more`} className="flex flex-col items-end gap-1">
              {more.map((c) => (
                <li key={c.value}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canAllow}
                    onClick={() => void submit("approve", false, c.value)}
                    data-testid={`approval-more-${c.value}`}
                  >
                    {c.label}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* Below the buttons, so choosing it never moves them (§3.3): who else gets the folder. */}
      {interactive &&
      inSpaceOffer !== null &&
      inSpaceOffer.name !== "" &&
      (second?.value === "space" || (moreOpen && more.some((c) => c.value === "space"))) ? (
        <p className="mt-2 text-callout text-label-secondary" data-testid="space-automations">
          {t(
            inSpaceOffer.automationsWrite
              ? "blocks.folder.space.automationsWrite"
              : "blocks.folder.space.automationsRead",
            { space: inSpaceOffer.name },
          )}
        </p>
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
