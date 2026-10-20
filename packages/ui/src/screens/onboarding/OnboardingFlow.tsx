import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_CREATURE } from "../../avatar/creatures/index.tsx";
import { PsycheMark } from "../../brand.tsx";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";
import { CONNECTOR_CATALOG, type ScopeMode } from "../settings/ConnectorsSection.tsx";
import { messageOf } from "../settings/shared.tsx";
import type { TccPermission } from "../settings/types.ts";
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
 * Onboarding (UI design §3.19): a six-step stepper. The OS prompts, connect flows, key storage
 * and the tool-calling check run in the shell through callback props; the flow ends with
 * `onComplete(result)`, which writes IDENTITY.md and starts BOOTSTRAP.md.
 */

export function stepLabel(step: OnboardingStepId, persona: string): string {
  switch (step) {
    case "agent":
      return "Meet your agent";
    case "permissions":
      return "Permissions";
    case "connectors":
      return "Connectors";
    case "model":
      return "Model & provider";
    case "where":
      return `Where ${persona} works`;
    case "done":
      return "Done";
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
}: OnboardingFlowProps): ReactElement {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [own, setOwn] = useState<OnboardingStepId>(defaultStep);
  const current = step ?? own;
  const index = ONBOARDING_STEP_IDS.indexOf(current);
  const [reached, setReached] = useState(index);

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
  const [connectors, setConnectors] = useState<ConnectedAccount[]>(initial.connectors ?? []);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelChoice>(initial.model ?? defaultModelChoice("cloud"));
  const [keyError, setKeyError] = useState<string | null>(null);
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
    setReached((r) => Math.max(r, ONBOARDING_STEP_IDS.indexOf(next)));
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
    setConnectError(null);
    setConnecting(true);
    try {
      const ok = onConnect ? await onConnect(type, mode) : true;
      if (ok !== false) {
        const label = CONNECTOR_CATALOG.find((c) => c.type === type)?.label ?? type;
        setConnectors((list) => [...list.filter((c) => c.type !== type), { type, label, mode }]);
      }
    } catch (err) {
      setConnectError(`Psyche couldn't connect that account (${messageOf(err)}).`);
    } finally {
      setConnecting(false);
    }
  };

  const saveKey = onSaveKey
    ? async (key: string) => {
        setKeyError(null);
        try {
          const saved = await onSaveKey(model.provider, key);
          const keyRef = typeof saved === "string" ? saved : saved.keyRef;
          if (typeof saved !== "string" && saved.recoveryKey) setRecoveryKey(saved.recoveryKey);
          setModel((m) => ({ ...m, keyRef }));
        } catch (err) {
          setKeyError(`Psyche couldn't store the key (${messageOf(err)}).`);
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
        setChecks([{ id: "setup", label: "Setup check", state: "warn", detail: messageOf(err) }]),
    );
    return () => {
      live = false;
    };
  }, [current, onVerify]);

  return (
    <div
      // A centered column (UI design §4.1: prose width plus the preview column). In a flex
      // parent it is also centred vertically (`my-auto`) with a steady minimum height, so the
      // step body never floats above an empty window and Back / Next keep their place between
      // steps; taller steps scroll. `shrink-0`: with an explicit min-height a flex item may
      // otherwise shrink to the window and let Back / Next overflow below the column.
      className="mx-auto my-auto flex w-full max-w-4xl shrink-0 flex-col gap-6 px-6 py-8 sm:px-10 md:min-h-[600px]"
      data-testid="onboarding-flow"
    >
      <header className="flex flex-col gap-5">
        <span className="text-accent-11" data-testid="onboarding-mark">
          <PsycheMark size={24} />
        </span>
        <nav aria-label="Onboarding progress">
          <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {ONBOARDING_STEP_IDS.map((s, i) => {
              const active = s === current;
              const done = i < index;
              const reachable = i <= reached && !active;
              const label = stepLabel(s, name);
              return (
                <li
                  key={s}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5",
                    active ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border text-xs",
                      active
                        ? "border-accent-9 bg-accent-9 text-accent-contrast"
                        : done
                          ? "border-accent-7 text-accent-11"
                          : "border-gray-7",
                    )}
                  >
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  {reachable ? (
                    <button
                      type="button"
                      className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => go(s)}
                    >
                      {label}
                      {done ? <span className="sr-only"> (done)</span> : null}
                    </button>
                  ) : (
                    <span>{label}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <section aria-labelledby={headingId} className="flex flex-1 flex-col gap-4">
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-h1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">
            Step {index + 1} of {ONBOARDING_STEP_IDS.length}:{" "}
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
            connected={connectors}
            busy={connecting}
            error={connectError}
            onConnect={(type, mode) => void connect(type, mode)}
          />
        ) : null}
        {current === "model" ? (
          <ModelStep
            value={model}
            onChange={setModel}
            keyError={keyError}
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
          <DoneStep result={result} {...(checks === null ? {} : { checks })} />
        ) : null}
      </section>

      <div
        className="mt-auto flex items-center justify-between gap-2 border-t border-gray-6 pt-4"
        data-testid="onboarding-nav"
      >
        <Button
          type="button"
          variant="ghost"
          disabled={index === 0}
          onClick={() => {
            const prev = ONBOARDING_STEP_IDS[index - 1];
            if (prev) go(prev);
          }}
        >
          <ArrowLeft aria-hidden="true" /> Back
        </Button>
        {current === "connectors" && connectors.length === 0 ? (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              const next = ONBOARDING_STEP_IDS[index + 1];
              if (next) go(next);
            }}
          >
            Skip for now
          </Button>
        ) : null}
        {isLast ? (
          <Button type="button" onClick={() => onComplete(result)}>
            Open the main chat
          </Button>
        ) : (
          <Button
            type="button"
            disabled={recoveryPending}
            onClick={() => {
              const next = ONBOARDING_STEP_IDS[index + 1];
              if (next) go(next);
            }}
          >
            Next
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
