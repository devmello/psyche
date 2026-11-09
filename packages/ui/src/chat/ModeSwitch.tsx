import { type ReactElement, useState } from "react";
import { t } from "../i18n/core.ts";
import {
  autoExplainerSeen,
  autoModeBlockedBy,
  autoModeSuggestion,
  isAutoModelRefusal,
  type ListedModels,
  markAutoExplainerSeen,
  SWITCH_MODES,
  type SwitchMode,
  shortModel,
} from "./mode-switch.ts";

const LABEL: Record<SwitchMode, () => string> = {
  manual: () => t("agent.mode.manual"),
  balanced: () => t("agent.mode.balanced"),
  auto: () => t("agent.mode.auto"),
};

export interface ModeSwitchProps {
  /** The thread's mode (plan and anything else select nothing). */
  mode: string | undefined;
  /** The thread's pinned model; null when it follows the primary role. */
  modelRef: string | null;
  /** `models.list`, once loaded. */
  listed: ListedModels | undefined;
  /**
   * Applies the choice (this chat, and the default for new ones). `modelRef` is set when the
   * owner took the offer to switch models. Rejects with the Gateway's error.
   */
  onSelect: (mode: SwitchMode, modelRef?: string) => Promise<void>;
  disabled?: boolean;
}

/**
 * Manual / Balanced / Auto in one click, above the composer. Auto on a model that cannot run it
 * turns into an offer: "Switch to <model> and use Auto". The first time Auto is chosen a
 * one-line explanation appears under the switch; it never blocks the choice.
 */
export function ModeSwitch({
  mode,
  modelRef,
  listed,
  onSelect,
  disabled = false,
}: ModeSwitchProps): ReactElement {
  const [offer, setOffer] = useState<{ model: string | null } | null>(null);
  const [explainer, setExplainer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (next: SwitchMode, pinned?: string): Promise<void> => {
    setError(null);
    if (next === "auto" && pinned === undefined) {
      const blocked = autoModeBlockedBy(listed, modelRef);
      if (blocked !== null) {
        setOffer({ model: blocked });
        return;
      }
    }
    setOffer(null);
    setBusy(true);
    try {
      await onSelect(next, pinned);
      if (next === "auto" && !autoExplainerSeen(safeStorage())) setExplainer(true);
    } catch (err) {
      const refusal = isAutoModelRefusal(err);
      if (refusal !== null) setOffer(refusal);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const suggestion = offer === null ? null : autoModeSuggestion(listed, modelRef);

  return (
    <div className="flex flex-col gap-1.5" data-testid="mode-switch">
      <div
        role="radiogroup"
        aria-label={t("chat.modeSwitch.label")}
        className="inline-flex w-fit gap-0.5 rounded-full bg-fill-secondary p-0.5"
      >
        {SWITCH_MODES.map((m) => {
          const selected = mode === m;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control; the group is a radiogroup
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || busy}
              data-testid={`mode-switch-${m}`}
              className={`cursor-default rounded-full px-3 py-0.5 text-callout ${
                selected
                  ? "bg-surface-raised font-medium text-label-primary shadow-elevation-1"
                  : "text-label-secondary hover:text-label-primary"
              }`}
              onClick={() => void choose(m)}
            >
              {LABEL[m]()}
            </button>
          );
        })}
      </div>
      {offer !== null ? (
        <p
          className="flex flex-wrap items-center gap-2 text-callout text-label-secondary"
          role="status"
          data-testid="mode-switch-offer"
        >
          {suggestion === null ? (
            t("chat.modeSwitch.noModel")
          ) : (
            <>
              <span>
                {offer.model === null
                  ? t("chat.modeSwitch.needsModel")
                  : t("chat.modeSwitch.autoUnavailable", { model: shortModel(offer.model) })}
              </span>
              <button
                type="button"
                className="cursor-default rounded-sm bg-fill-secondary px-2 py-0.5 font-medium text-label-primary hover:bg-fill-primary"
                data-testid="mode-switch-take-offer"
                onClick={() => void choose("auto", suggestion)}
              >
                {t("chat.modeSwitch.switchModel", { model: shortModel(suggestion) })}
              </button>
            </>
          )}
        </p>
      ) : null}
      {explainer ? (
        <p
          className="flex flex-wrap items-center gap-2 text-callout text-label-secondary"
          data-testid="mode-switch-explainer"
        >
          <span>{t("chat.modeSwitch.autoExplainer")}</span>
          <button
            type="button"
            className="cursor-default rounded-sm bg-fill-secondary px-2 py-0.5 font-medium text-label-primary hover:bg-fill-primary"
            onClick={() => {
              markAutoExplainerSeen(safeStorage());
              setExplainer(false);
            }}
          >
            {t("chat.modeSwitch.gotIt")}
          </button>
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-callout text-danger-text">
          {t("chat.modeSwitch.failed", { reason: error })}
        </p>
      ) : null}
    </div>
  );
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
