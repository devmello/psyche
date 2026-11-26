import { Loader } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { Button } from "../../components/ui/button.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import { isWindows } from "../../lib/platform.ts";
import { effectiveHoldKey, holdKeyLabel } from "../../voice/hold-keys.ts";
import { SCOPE_MODE_LABEL } from "../settings/ConnectorsSection.tsx";
import { Facts, StatusChip } from "../settings/shared.tsx";
import { ModelTestBadge } from "./OnboardingSteps.tsx";
import type { OnboardingResult, OnboardingTryTarget, SetupCheck } from "./types.ts";

const CHECK_TONE = {
  ok: "success",
  warn: "approval",
  fail: "danger",
  unchecked: "neutral",
} as const;

function checkChip(state: SetupCheck["state"]): string {
  switch (state) {
    case "ok":
      return t("onboarding.done.ok");
    case "fail":
      return t("onboarding.done.failed");
    case "unchecked":
      return t("onboarding.done.notChecked");
    case "warn":
      return t("onboarding.done.check");
  }
}

/** Done's line for mail and meetings: how many workflows are on, or that they're off. */
function mailDoneValue(mail: NonNullable<OnboardingResult["mail"]>): string {
  const n = Object.values(mail).filter(Boolean).length;
  return n === 0 ? t("onboarding.mail.doneOff") : t("onboarding.mail.doneOn", { n });
}

const onOff = (on: boolean) => (on ? t("onboarding.done.on") : t("onboarding.done.off"));

/**
 * The last step: what was set up, the setup checks, and three things to try (not setup), as
 * buttons: a question in Search, Catching up on Home, and a new chat.
 */
export function DoneStep({
  result,
  checks,
  helperConnected = false,
  onFix,
  onTry,
}: {
  /** Finishes setup and opens the place a "Try next" button names. */
  onTry?: (target: OnboardingTryTarget) => void;
  /** Opens the step that fixes a failed or unchecked row (the Model step). */
  onFix?: (step: NonNullable<SetupCheck["fixStep"]>) => void;
  result: OnboardingResult;
  /** The Mac helper is paired: the voice key works, so say how to talk (voice-mode-2026 §6.5). */
  helperConnected?: boolean;
  /** What `onVerify` found; "checking" while it runs. */
  checks?: SetupCheck[] | "checking";
}): ReactElement {
  const tryId = useId();
  const p = result.persona;
  const daily = result.habits
    ? [
        result.habits.brief ? t("onboarding.habits.brief") : null,
        result.habits.wrapup ? t("onboarding.habits.wrapup") : null,
        result.habits.followups ? t("onboarding.habits.followups") : null,
      ].filter((x): x is string => x !== null)
    : null;
  // A model row that is not fine means chat will not answer yet: say so instead of "ready".
  const modelRow = Array.isArray(checks) ? checks.find((c) => c.id === "model") : undefined;
  const notReady =
    modelRow !== undefined && (modelRow.state === "warn" || modelRow.state === "fail");
  return (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <Avatar name={p.name} creature={p.creatureId} size={64} />
        <div>
          <p className="text-title-3 text-label-primary">
            {notReady
              ? t("onboarding.done.notReady", { name: p.name })
              : t("onboarding.done.ready", { name: p.name })}
          </p>
          <p className="text-reading text-label-secondary">
            {notReady
              ? t("onboarding.done.notReadyBody")
              : t("onboarding.done.opens", { name: p.name })}
          </p>
          {helperConnected ? (
            <p className="text-reading text-label-secondary" data-testid="onboarding-voice-hint">
              {t("voice.onboarding.hint", {
                // The voice key's default: Right ⌘ on a Mac, Right Alt on Windows.
                key: isWindows()
                  ? holdKeyLabel(effectiveHoldKey(undefined, "voice"))
                  : t("voice.key.rightCommand"),
                name: p.name,
              })}
            </p>
          ) : null}
        </div>
      </div>
      <Facts
        className="text-sm"
        items={[
          {
            term: t("onboarding.done.accounts"),
            value:
              result.connectors.length > 0
                ? activeI18n().list(
                    result.connectors.map((c) =>
                      t("onboarding.done.account", {
                        label: c.label,
                        mode: SCOPE_MODE_LABEL[c.mode].toLocaleLowerCase(
                          activeI18n().messageLocale,
                        ),
                      }),
                    ),
                  )
                : t("onboarding.done.noneYet"),
          },
          ...(result.mail
            ? [{ term: t("onboarding.mail.done"), value: mailDoneValue(result.mail) }]
            : []),
          {
            term: t("onboarding.done.model"),
            value: result.modelKept ? (
              t("onboarding.done.modelKept")
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-callout">{result.model.modelRef}</code>
                <ModelTestBadge status={result.model.toolCheck} />
              </span>
            ),
          },
          ...(daily
            ? [
                {
                  term: t("onboarding.done.daily"),
                  value: daily.length > 0 ? activeI18n().list(daily) : t("onboarding.done.off"),
                },
              ]
            : []),
          ...(result.memory
            ? [
                { term: t("onboarding.done.work"), value: onOff(result.memory.work) },
                { term: t("onboarding.done.people"), value: onOff(result.memory.people) },
              ]
            : []),
          ...(result.touchIdRegistered === undefined
            ? []
            : [
                {
                  term: t("onboarding.done.touchId"),
                  value: result.touchIdRegistered
                    ? t("onboarding.done.touchIdSet")
                    : t("onboarding.done.touchIdNot"),
                },
              ]),
        ]}
      />
      {checks === "checking" ? (
        <p className="flex items-center gap-2 text-callout text-label-secondary" role="status">
          <Loader className="size-4 motion-safe:animate-spin" aria-hidden="true" />{" "}
          {t("onboarding.done.checking")}
        </p>
      ) : checks ? (
        <ul
          className="flex w-full flex-col gap-2"
          aria-label={t("onboarding.done.checks")}
          data-testid="setup-checks"
        >
          {checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusChip tone={CHECK_TONE[c.state]}>{checkChip(c.state)}</StatusChip>
              <span className="font-medium">{c.label}</span>
              <span className="text-muted-foreground">{c.detail}</span>
              {c.fixStep && onFix ? (
                <button
                  type="button"
                  className="text-callout text-ink underline underline-offset-2"
                  onClick={() => onFix(c.fixStep as NonNullable<SetupCheck["fixStep"]>)}
                >
                  {t("onboarding.done.fixModel")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <section aria-labelledby={tryId} className="flex flex-col gap-2" data-testid="onboarding-try">
        <h2 id={tryId} className="text-headline text-label-primary">
          {t("onboarding.done.try")}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {(
            [
              ["search", t("onboarding.done.try.search")],
              ["home", t("onboarding.done.try.home")],
              ["chat", t("onboarding.done.try.chat")],
            ] as const
          ).map(([target, label]) => (
            <li key={target}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={onTry === undefined}
                onClick={() => onTry?.(target)}
              >
                {label}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
