import { ArrowLeft, ArrowRight } from "lucide-react";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_CREATURE } from "../../avatar/creatures/index.tsx";
import { PsycheMark } from "../../brand.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { cn } from "../../lib/utils.ts";
import {
  CONNECTOR_CATALOG,
  type ScopeMode,
  useImplementedTypes,
} from "../settings/ConnectorsSection.tsx";
import { ConnectProgress, permissionOf, useConnectorConnect } from "../settings/connect-flow.tsx";
import type { TccPermission } from "../settings/types.ts";
import { MAIL_DEFAULTS, MailStep } from "./MailStep.tsx";
import {
  ConnectorsStep,
  DEFAULT_NAME,
  DoneStep,
  defaultModelChoice,
  MeetStep,
  ModelStep,
  PermissionsStep,
  WhereStep,
} from "./OnboardingSteps.tsx";
import {
  type ConnectedAccount,
  type MailChoices,
  type ModelChoice,
  ONBOARDING_STEP_IDS,
  type OnboardingResult,
  type OnboardingShellProps,
  type OnboardingStepId,
  type PermissionAnswer,
  type PermissionResult,
  type PersonaDraft,
  type SetupCheck,
  type Workspace,
} from "./types.ts";

/**
 * Onboarding (UI design §3.19; redesign-2026 §5.9): one centred column, step dots, one decision
 * per step. The OS prompts, connect flows, key storage
 * and the tool-calling check run in the shell through callback props; the flow ends with
 * `onComplete(result)`, which writes IDENTITY.md and starts BOOTSTRAP.md.
 */

/** Connector types that are mail accounts (they trigger the mail decision screen). */
const MAIL_CONNECTOR_TYPES: ReadonlySet<string> = new Set([
  "google",
  "microsoft",
  "imap",
  "apple:mail",
]);

export function stepLabel(step: OnboardingStepId, persona: string): string {
  switch (step) {
    case "agent":
      return t("onboarding.step.agent");
    case "permissions":
      return t("onboarding.step.permissions");
    case "connectors":
      return t("onboarding.step.connectors");
    case "mail":
      return t("onboarding.step.mail");
    case "model":
      return t("onboarding.step.model");
    case "where":
      return t("onboarding.step.where", { name: persona });
    case "done":
      return t("onboarding.step.done");
  }
}

export interface OnboardingFlowProps extends OnboardingShellProps {
  /** Controlled step (from the `/onboarding/:step` route). */
  step?: OnboardingStepId;
  defaultStep?: OnboardingStepId;
  onStepChange?: (step: OnboardingStepId) => void;
  /** Starting values, e.g. when onboarding resumes. */
  initial?: Partial<{
    persona: Partial<PersonaDraft>;
    permissions: Partial<Record<TccPermission, PermissionAnswer>>;
    connectors: ConnectedAccount[];
    model: ModelChoice;
    workspace: Workspace;
  }>;
  onComplete: (result: OnboardingResult) => void;
}

/** A request's or read's result as the row's answer. */
function answerOf(state: PermissionResult): PermissionAnswer {
  return state === "granted" ? "granted" : state === "unavailable" ? "unavailable" : "denied";
}

export function OnboardingFlow({
  step,
  defaultStep = "agent",
  onStepChange,
  initial = {},
  onComplete,
  ramGb,
  onRequestPermission,
  onReadPermissions,
  onConnect,
  onSaveKey,
  onCheckModel,
  vmAvailable = true,
  helper,
  onVerify,
  macPermissions = true,
}: OnboardingFlowProps): ReactElement {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [own, setOwn] = useState<OnboardingStepId>(defaultStep);

  const [persona, setPersona] = useState<PersonaDraft>({
    name: "",
    creatureId: DEFAULT_CREATURE,
    creatureMode: "bundled",
    creatureDescription: "",
    tagline: "",
    ...initial.persona,
  });
  const [permissions, setPermissions] = useState<Record<TccPermission, PermissionAnswer>>({
    accessibility: "pending",
    screenRecording: "pending",
    notifications: "pending",
    ...initial.permissions,
  });
  const [askingPermission, setAskingPermission] = useState<TccPermission | null>(null);
  const [hostConnectors, setConnectors] = useState<ConnectedAccount[]>(initial.connectors ?? []);
  // Without a host override, Connect is the real sign-in and the list is the Gateway's: an
  // account shows as connected only once it holds a token (#505), as in Settings → Connectors.
  const builtInConnect = onConnect === undefined;
  const flow = useConnectorConnect();
  const implemented = useImplementedTypes();
  const live = useGatewayQuery("connectors.list", {}, { enabled: builtInConnect });
  // Every instance the Gateway has, with its status (#620): one waiting on a macOS permission or
  // a sign-in is listed (and resumable), so its type is not offered again.
  const liveConnectors = (live.data?.connectors ?? []).filter((c) => c.status !== "disconnected");
  const accounts: ConnectedAccount[] = builtInConnect
    ? liveConnectors.map((c) => ({
        type: c.type,
        label: CONNECTOR_CATALOG.find((x) => x.type === c.type)?.label ?? c.label,
        mode: c.scopeMode,
        status:
          c.status === "connected" ? "connected" : c.status === "error" ? "error" : "needs_auth",
        needs: permissionOf(c) !== null ? "permission" : "sign_in",
        connectorId: c.id,
      }))
    : hostConnectors;
  // What the result and "Skip for now" count: the accounts that are connected.
  const connectors = accounts.filter((c) => (c.status ?? "connected") === "connected");
  // The mail decision screen is offered once a mail account is connected (§7.5).
  const mailConnected = connectors.some((c) => MAIL_CONNECTOR_TYPES.has(c.type));
  const steps = ONBOARDING_STEP_IDS.filter(
    (s) => (s !== "permissions" || macPermissions) && (s !== "mail" || mailConnected),
  );
  const asked = step ?? own;
  const current = steps.includes(asked)
    ? asked
    : (steps[ONBOARDING_STEP_IDS.indexOf(asked)] ?? "agent");
  const index = steps.indexOf(current);
  const [reached, setReached] = useState(index);
  const [mail, setMail] = useState<MailChoices>(MAIL_DEFAULTS);
  const resumeConnector = (account: ConnectedAccount) => {
    const c = liveConnectors.find((x) => x.id === account.connectorId);
    if (c !== undefined) void flow.resume(c, account.label);
  };
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelChoice>(initial.model ?? defaultModelChoice("cloud"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyRefused, setKeyRefused] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  // A vault created in this step shows its recovery key once: the owner must confirm saving it
  // before leaving the step.
  const recoveryPending = recoveryKey !== null && !recoverySaved;
  const [checks, setChecks] = useState<SetupCheck[] | "checking" | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>(initial.workspace ?? "local");

  const name = persona.name.trim() === "" ? DEFAULT_NAME : persona.name.trim();

  const go = (next: OnboardingStepId) => {
    if (recoveryPending) return;
    setOwn(next);
    setReached((r) => Math.max(r, steps.indexOf(next)));
    onStepChange?.(next);
  };

  // Move focus to the new step's heading so keyboard and screen-reader users land on it.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [current]);

  const result: OnboardingResult = {
    persona: {
      name,
      creatureId: persona.creatureId,
      creatureDescription:
        persona.creatureMode === "describe" && persona.creatureDescription.trim() !== ""
          ? persona.creatureDescription.trim()
          : null,
      tagline: persona.tagline.trim(),
    },
    permissions,
    connectors,
    model,
    workspace,
    ...(mailConnected ? { mail } : {}),
  };

  const allow = async (p: TccPermission) => {
    if (!onRequestPermission) {
      setPermissions((s) => ({ ...s, [p]: "unavailable" }));
      return;
    }
    setAskingPermission(p);
    try {
      const state = await onRequestPermission(p);
      setPermissions((s) => ({ ...s, [p]: answerOf(state) }));
    } catch {
      setPermissions((s) => ({ ...s, [p]: "unavailable" }));
    } finally {
      setAskingPermission(null);
    }
  };

  // The owner flips most switches in System Settings: re-read the real state when this window
  // gets focus again, and when the Permissions step opens. A row the owner skipped stays skipped
  // unless macOS now says it is allowed.
  useEffect(() => {
    if (!onReadPermissions || current !== "permissions") return;
    let live = true;
    const read = () => {
      void onReadPermissions().then(
        (states) => {
          if (!live) return;
          setPermissions((s) => {
            const next = { ...s };
            for (const [p, state] of Object.entries(states) as [
              TccPermission,
              PermissionResult,
            ][]) {
              if (state === "granted") next[p] = "granted";
              else if (s[p] === "granted" || s[p] === "denied") next[p] = answerOf(state);
            }
            return next;
          });
        },
        () => undefined,
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [onReadPermissions, current]);

  const connect = async (type: string, mode: ScopeMode) => {
    if (builtInConnect) {
      await flow.start(type, mode, CONNECTOR_CATALOG.find((c) => c.type === type)?.label ?? type);
      return;
    }
    setConnectError(null);
    setConnecting(true);
    try {
      const ok = onConnect ? await onConnect(type, mode) : true;
      if (ok !== false) {
        const label = CONNECTOR_CATALOG.find((c) => c.type === type)?.label ?? type;
        setConnectors((list) => [...list.filter((c) => c.type !== type), { type, label, mode }]);
      }
    } catch (err) {
      setConnectError(t("onboarding.connectFailed", { reason: describeError(err) }));
    } finally {
      setConnecting(false);
    }
  };

  const saveKey = onSaveKey
    ? async (key: string) => {
        setKeyError(null);
        setKeyRefused(false);
        try {
          const saved = await onSaveKey(model.provider, key);
          const keyRef = typeof saved === "string" ? saved : saved.keyRef;
          if (typeof saved !== "string" && saved.recoveryKey) setRecoveryKey(saved.recoveryKey);
          if (typeof saved !== "string" && saved.refused !== undefined) {
            // Keep the field open: another paste replaces the refused key.
            setKeyError(t("onboarding.keyRefused", { reason: saved.refused }));
            setKeyRefused(true);
            return;
          }
          setModel((m) => ({ ...m, keyRef }));
        } catch (err) {
          setKeyError(t("onboarding.keyFailed", { reason: describeError(err) }));
        }
      }
    : undefined;

  const check = onCheckModel
    ? async () => {
        setModel((m) => ({ ...m, toolCheck: "running" }));
        const { toolCheck: _ignored, ...choice } = model;
        try {
          const outcome = await onCheckModel(choice);
          setModel((m) => ({ ...m, toolCheck: outcome }));
        } catch {
          setModel((m) => ({ ...m, toolCheck: "failed" }));
        }
      }
    : undefined;

  const isLast = current === "done";

  // Entering Done applies the model and checks the setup once per visit.
  const resultRef = useRef(result);
  resultRef.current = result;
  useEffect(() => {
    if (current !== "done" || !onVerify) return;
    let live = true;
    setChecks("checking");
    onVerify(resultRef.current).then(
      (c) => live && setChecks(c),
      (err: unknown) =>
        live &&
        setChecks([
          {
            id: "setup",
            label: t("onboarding.setupCheck"),
            state: "warn",
            detail: describeError(err),
          },
        ]),
    );
    return () => {
      live = false;
    };
  }, [current, onVerify]);

  // Which way the step body slides in: forward from the trailing side, back from the leading.
  const lastIndex = useRef(index);
  const direction = index >= lastIndex.current ? "forward" : "back";
  useEffect(() => {
    lastIndex.current = index;
  }, [index]);

  return (
    <div
      // One centred 560 px column (docs/design/redesign-2026.md §5.9). In a flex parent it is
      // also centred vertically (`my-auto`) with a steady minimum height, so Back / Next keep
      // their place between steps; taller steps scroll. `shrink-0`: with an explicit min-height
      // a flex item may otherwise shrink to the window and let Back / Next overflow.
      className="mx-auto my-auto flex w-full max-w-[608px] shrink-0 flex-col gap-8 bg-canvas px-6 py-10 md:min-h-[600px]"
      data-testid="onboarding-flow"
    >
      <header className="flex flex-col items-center gap-5">
        <span className="text-label-tertiary" data-testid="onboarding-mark">
          <PsycheMark size={24} />
        </span>
        <nav aria-label={t("onboarding.progress")}>
          {/* Step dots; each dot is named for VoiceOver and the visited ones are buttons. */}
          <ol className="flex items-center gap-2">
            {steps.map((s, i) => {
              const active = s === current;
              const done = i < index;
              const reachable = i <= reached && !active;
              const label = stepLabel(s, name);
              const dot = cn(
                "block h-2 rounded-full transition-colors duration-(--duration-short)",
                active ? "w-5 bg-accent-9" : done ? "w-2 bg-accent-7" : "w-2 bg-fill-primary",
              );
              return (
                <li key={s} aria-current={active ? "step" : undefined}>
                  {reachable ? (
                    <button
                      type="button"
                      className="flex h-6 cursor-default items-center rounded-full px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => go(s)}
                    >
                      <span aria-hidden="true" className={dot} />
                      <span className="sr-only">
                        {label}
                        {done ? ` ${t("onboarding.doneMark")}` : ""}
                      </span>
                    </button>
                  ) : (
                    <span className="flex h-6 items-center px-0.5">
                      <span aria-hidden="true" className={dot} />
                      <span className="sr-only">{label}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <section
        key={current}
        aria-labelledby={headingId}
        data-direction={direction}
        // Steps change with a 24 px slide plus a crossfade on spring.gentle (§5.9).
        className={cn(
          "flex flex-1 flex-col gap-6 animate-in fade-in-0 duration-(--spring-gentle-duration) ease-(--spring-gentle)",
          direction === "forward"
            ? "slide-in-from-right-6 rtl:slide-in-from-left-6"
            : "slide-in-from-left-6 rtl:slide-in-from-right-6",
        )}
      >
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-large-title text-label-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">
            {t("onboarding.stepOf", { n: index + 1, total: steps.length })}{" "}
          </span>
          {stepLabel(current, name)}
        </h1>

        {current === "agent" ? <MeetStep value={persona} onChange={setPersona} /> : null}
        {current === "permissions" ? (
          <PermissionsStep
            persona={name}
            value={permissions}
            busy={askingPermission}
            {...(helper ? { helper } : {})}
            onAllow={(p) => void allow(p)}
            onSkip={(p) => setPermissions((s) => ({ ...s, [p]: "skipped" }))}
          />
        ) : null}
        {current === "connectors" ? (
          <ConnectorsStep
            persona={name}
            connected={accounts}
            busy={
              builtInConnect
                ? flow.state.phase === "starting" || flow.state.phase === "signing-in"
                : connecting
            }
            error={connectError}
            onConnect={(type, mode) => void connect(type, mode)}
            {...(builtInConnect ? { implemented, onResume: resumeConnector } : {})}
            {...(builtInConnect
              ? {
                  progress: (
                    <ConnectProgress
                      state={flow.state}
                      onOpen={(url) => void flow.open(url)}
                      onCancel={flow.cancel}
                      onRetry={flow.retry}
                      onOpenSettings={() => void flow.openSettings()}
                      onRecheck={() => void flow.recheck()}
                    />
                  ),
                }
              : {})}
          />
        ) : null}
        {current === "mail" ? <MailStep persona={name} value={mail} onChange={setMail} /> : null}
        {current === "model" ? (
          <ModelStep
            value={model}
            onChange={setModel}
            keyError={keyError}
            keyRefused={keyRefused}
            {...(recoveryKey
              ? { recoveryKey, recoverySaved, onRecoverySaved: setRecoverySaved }
              : {})}
            {...(ramGb === undefined ? {} : { ramGb })}
            {...(saveKey ? { onSaveKey: (k: string) => void saveKey(k) } : {})}
            {...(check ? { onCheck: () => void check() } : {})}
          />
        ) : null}
        {current === "where" ? (
          <WhereStep
            persona={name}
            value={workspace}
            onChange={setWorkspace}
            vmAvailable={vmAvailable}
          />
        ) : null}
        {current === "done" ? (
          <DoneStep
            result={result}
            permissionsOnMac={!macPermissions}
            helperConnected={helper?.kind === "paired"}
            {...(checks === null ? {} : { checks })}
          />
        ) : null}
      </section>

      <div className="mt-auto flex items-center gap-2" data-testid="onboarding-nav">
        <Button
          type="button"
          variant="plain"
          disabled={index === 0}
          onClick={() => {
            const prev = steps[index - 1];
            if (prev) go(prev);
          }}
        >
          <ArrowLeft aria-hidden="true" className="rtl:rotate-180" /> {t("onboarding.back")}
        </Button>
        <span className="ms-auto" />
        {current === "connectors" && connectors.length === 0 ? (
          <Button
            type="button"
            variant="plain"
            onClick={() => {
              const next = steps[index + 1];
              if (next) go(next);
            }}
          >
            {t("onboarding.skipForNow")}
          </Button>
        ) : null}
        {isLast ? (
          <Button type="button" size="lg" onClick={() => onComplete(result)}>
            {t("onboarding.openChat")}
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            disabled={recoveryPending}
            onClick={() => {
              const next = steps[index + 1];
              if (next) go(next);
            }}
          >
            {t("onboarding.next")}
            <ArrowRight aria-hidden="true" className="rtl:rotate-180" />
          </Button>
        )}
      </div>
    </div>
  );
}
