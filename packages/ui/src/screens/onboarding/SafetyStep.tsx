import { ChevronRight, Loader } from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { isWindows } from "../../lib/platform.ts";
import { cn } from "../../lib/utils.ts";
import { type MacHelperStatus, MacHelperStatusRow } from "../settings/MacHelperStatus.tsx";
import { CARD, CARD_ROWS, StatusChip, SwitchField } from "../settings/shared.tsx";
import { keyIdShort, presenceKeyText } from "../settings/TouchIdKeySetup.tsx";
import type { TccState } from "../settings/types.ts";
import { WindowsAccessRows } from "../settings/WindowsAccess.tsx";
import { SandboxStep } from "./SandboxStep.tsx";
import type { PermissionAnswer, TouchIdSetupPort, TouchIdStatus } from "./types.ts";

/** A row of the safety card: what it is and why, with its state or action trailing. */
function Row({
  title,
  chip,
  children,
  action,
}: {
  title: string;
  chip?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-body text-label-primary">
          {title}
          {chip}
        </p>
        {children}
      </div>
      {action}
    </div>
  );
}

const hint = "text-callout text-label-secondary";

/** The helper bundled with this app: the Windows helper on Windows, else the Mac helper. */
const bundledHelperKind = (): string => (isWindows() ? "win-helper" : "mac-helper");

/** An onboarding answer as a grant state: skipped and unavailable read as not checked. */
const tccOf = (a: PermissionAnswer): TccState =>
  a === "granted" ? "granted" : a === "denied" ? "denied" : "not_determined";

/**
 * The helper's Touch ID key (security §10), registered once. The key shown is the one the helper
 * inside this app reports and the button registers exactly that key, as Settings → Devices does.
 * A build without a provisioning profile has a development key, which needs its own switch first.
 * Not shown when this build bundles no helper.
 */
export function useTouchId(
  port: TouchIdSetupPort | undefined,
  helperKind: MacHelperStatus["kind"] | undefined,
  onRegisteredChange?: ((registered: boolean) => void) | undefined,
) {
  const [status, setStatus] = useState<TouchIdStatus | "loading" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    if (!port) return;
    try {
      const next = await port.status();
      setStatus(next);
      onRegisteredChange?.(next.registered);
    } catch {
      setStatus("failed");
    }
  }, [port, onRegisteredChange]);
  // Read when Safety opens, and again when the helper's state changes (it may just have paired).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `helperKind` is the trigger
  useEffect(() => {
    void read();
  }, [read, helperKind]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await read();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  // No helper in this build, or the port could not ask: there is nothing to set up.
  const visible =
    port !== undefined && status !== "failed" && (status === "loading" || status.identity !== null);
  return { status, busy, error, read, act, visible };
}

export function TouchIdRow({
  port,
  helper,
  touchId: { status, busy, error, read, act },
}: {
  port: TouchIdSetupPort;
  helper?: MacHelperStatus | undefined;
  touchId: ReturnType<typeof useTouchId>;
}): ReactElement | null {
  if (status === "loading") {
    return (
      <Row title={t("onboarding.safety.touchId")}>
        <p className={hint} role="status">
          {t("onboarding.safety.touchId.checking")}
        </p>
      </Row>
    );
  }
  if (status === "failed" || status.identity === null) return null;

  const { identity, registered, allowDevFileKey } = status;
  const devKey = identity.kind === "enclave_file";
  const again = (
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void read()}>
      {t("onboarding.safety.touchId.again")}
    </Button>
  );

  let body: ReactElement;
  if (registered) {
    body = (
      <Row
        title={t("onboarding.safety.touchId")}
        chip={<StatusChip tone="success">{t("onboarding.safety.touchId.set")}</StatusChip>}
      >
        <p className={hint}>{t("onboarding.safety.touchId.setHint")}</p>
        {identity.keyId ? (
          <p className={hint} data-testid="touch-id-key-id">
            {presenceKeyText(identity, bundledHelperKind())}{" "}
            <code className="font-mono">{keyIdShort(identity.keyId)}</code>
          </p>
        ) : null}
      </Row>
    );
  } else if (identity.keyId === undefined) {
    // The helper is still starting, or could not make a key.
    body = (
      <Row title={t("onboarding.safety.touchId")} action={again}>
        <p className={hint}>
          {helper?.kind === "starting"
            ? t("onboarding.safety.touchId.starting")
            : t("onboarding.safety.touchId.noKey", { reason: identity.error ?? "unknown" })}
        </p>
      </Row>
    );
  } else {
    body = (
      <>
        <Row
          title={t("onboarding.safety.touchId")}
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || (devKey && !allowDevFileKey)}
              onClick={() => void act(() => port.register())}
            >
              {busy ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : null}
              {t("onboarding.safety.touchId.register")}
            </Button>
          }
        >
          <p className={hint}>{t("onboarding.safety.touchId.hint")}</p>
          <p className={hint} data-testid="touch-id-key-id">
            {presenceKeyText(identity, bundledHelperKind())}{" "}
            <code className="font-mono">{keyIdShort(identity.keyId)}</code>
          </p>
        </Row>
        {devKey ? (
          <SwitchField
            label={t("settings.devices.touchId.allowDevFileKey")}
            description={t("settings.devices.touchId.devFileKey")}
            checked={allowDevFileKey}
            disabled={busy}
            onChange={(on) => void act(() => port.allowDevFileKey(on))}
          />
        ) : null}
      </>
    );
  }
  return (
    <>
      {helper && helper.kind !== "paired" && helper.kind !== "unbundled" ? (
        <MacHelperStatusRow state={helper} />
      ) : null}
      {body}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Notifications: the one macOS grant asked here, because approvals need to reach a closed window. */
function NotificationsRow({
  answer,
  busy,
  onAllow,
}: {
  answer: PermissionAnswer;
  busy: boolean;
  onAllow: () => void;
}): ReactElement {
  const granted = answer === "granted";
  return (
    <Row
      title={t("onboarding.safety.notifications")}
      chip={
        granted ? (
          <StatusChip tone="success">{t("onboarding.permission.granted")}</StatusChip>
        ) : answer === "denied" ? (
          <StatusChip tone="danger">{t("onboarding.permission.denied")}</StatusChip>
        ) : undefined
      }
      action={
        granted ? null : (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAllow}>
            {busy ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : null}
            {busy ? t("onboarding.permission.asking") : t("onboarding.permission.allow")}
          </Button>
        )
      }
    >
      <p className={hint}>{t("onboarding.permission.why.notifications")}</p>
      {answer === "denied" ? <p className={hint}>{t("onboarding.permission.deniedHint")}</p> : null}
      {answer === "unavailable" ? (
        <p className={hint}>{t("onboarding.permission.unavailableHint")}</p>
      ) : null}
    </Row>
  );
}

/**
 * The sandbox, one step away: a closed disclosure that mounts the guided setup (which looks at
 * this Mac) only once it is opened.
 */
function SandboxDisclosure(): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-8 w-fit cursor-default items-center gap-1.5 rounded-md py-1 pe-2 text-callout font-medium text-label-secondary outline-none select-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-(--duration-micro) motion-reduce:transition-none rtl:-scale-x-100",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        {t("onboarding.safety.sandbox")}
        <span className="font-normal text-label-tertiary">{t("onboarding.safety.optional")}</span>
      </button>
      <div id={id} hidden={!open}>
        {open ? <SandboxStep /> : null}
      </div>
    </div>
  );
}

/**
 * Step 5: how approvals reach the owner and what runs without asking. Touch ID and Notifications
 * show only where this window can set them up (the desktop); access to files, apps and the
 * screen is not asked here but in chat, the first time it is needed.
 */
export function SafetyStep({
  persona,
  touchId,
  helper,
  onTouchIdRegistered,
  notifications,
  notificationsBusy = false,
  onAllowNotifications,
  windowsAccess,
}: {
  persona: string;
  touchId?: TouchIdSetupPort | undefined;
  helper?: MacHelperStatus | undefined;
  onTouchIdRegistered?: ((registered: boolean) => void) | undefined;
  /** Absent where this window can't ask macOS (the web): the row is left out. */
  notifications?: PermissionAnswer | undefined;
  notificationsBusy?: boolean;
  onAllowNotifications?: (() => void) | undefined;
  /**
   * The desktop on Windows: what Windows asks for (no Accessibility or Screen Recording grant;
   * the microphone privacy toggle), shown as information under the approval rows.
   */
  windowsAccess?:
    | { microphone: PermissionAnswer; onOpenMicrophone?: (() => void) | undefined }
    | undefined;
}): ReactElement {
  const touch = useTouchId(touchId, helper?.kind, onTouchIdRegistered);
  const hasRows =
    touch.visible || (notifications !== undefined && onAllowNotifications) || windowsAccess;
  return (
    <div className="flex flex-col gap-5" data-testid="onboarding-safety">
      <p className="text-reading text-label-secondary">
        {t("onboarding.safety.lead", { name: persona })}
      </p>
      {hasRows ? (
        <div className={cn(CARD)}>
          <div className={CARD_ROWS}>
            {touchId && touch.visible ? (
              <TouchIdRow port={touchId} helper={helper} touchId={touch} />
            ) : null}
            {notifications !== undefined && onAllowNotifications ? (
              <NotificationsRow
                answer={notifications}
                busy={notificationsBusy}
                onAllow={onAllowNotifications}
              />
            ) : null}
            {windowsAccess ? (
              <WindowsAccessRows
                persona={persona}
                microphone={tccOf(windowsAccess.microphone)}
                onOpenSettings={windowsAccess.onOpenMicrophone}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="text-callout text-label-secondary">
        {t("onboarding.safety.asks", { name: persona })}
      </p>
      <SandboxDisclosure />
    </div>
  );
}
