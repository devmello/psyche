import { Loader } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import { isWindows } from "../../lib/platform.ts";
import { effectiveHoldKey, holdKeyLabel } from "../../voice/hold-keys.ts";
import { SCOPE_MODE_LABEL } from "../settings/ConnectorsSection.tsx";
import { ToolCheckBadge } from "../settings/ModelSection.tsx";
import { Facts, StatusChip } from "../settings/shared.tsx";
import type { OnboardingResult, SetupCheck } from "./types.ts";

const CHECK_TONE = { ok: "success", warn: "approval" } as const;

/** Done's line for mail and meetings: how many workflows are on, or that they're off. */
function mailDoneValue(mail: NonNullable<OnboardingResult["mail"]>): string {
  const n = Object.values(mail).filter(Boolean).length;
  return n === 0 ? t("onboarding.mail.doneOff") : t("onboarding.mail.doneOn", { n });
}

const onOff = (on: boolean) => (on ? t("onboarding.done.on") : t("onboarding.done.off"));

/**
 * Step 6: what was set up, the setup checks, and three things to try (not setup): a question in
 * Search, Catching up on Home, and "What can you do?".
 */
export function DoneStep({
  result,
  checks,
  helperConnected = false,
}: {
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
  return (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <Avatar name={p.name} creature={p.creatureId} size={64} />
        <div>
          <p className="text-title-3 text-label-primary">
            {t("onboarding.done.ready", { name: p.name })}
          </p>
          <p className="text-reading text-label-secondary">
            {t("onboarding.done.opens", { name: p.name })}
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
                <ToolCheckBadge status={result.model.toolCheck} />
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
              <StatusChip tone={CHECK_TONE[c.state]}>
                {c.state === "ok" ? t("onboarding.done.ok") : t("onboarding.done.check")}
              </StatusChip>
              <span className="font-medium">{c.label}</span>
              <span className="text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <section aria-labelledby={tryId} className="flex flex-col gap-2" data-testid="onboarding-try">
        <h2 id={tryId} className="text-headline text-label-primary">
          {t("onboarding.done.try")}
        </h2>
        <ul className="flex flex-col gap-1.5 text-reading text-label-secondary">
          <li>{t("onboarding.done.try.search")}</li>
          <li>{t("onboarding.done.try.home")}</li>
          <li>{t("onboarding.done.try.canDo")}</li>
        </ul>
      </section>
    </div>
  );
}
