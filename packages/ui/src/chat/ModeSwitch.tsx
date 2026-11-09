import { type ReactElement, useState } from "react";
import { t } from "../i18n/core.ts";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import {
  autoExplainerSeen,
  autoModeBlockedBy,
  autoModeSuggestion,
  type DefaultSaved,
  isAutoModelRefusal,
  type ListedModels,
  markAutoExplainerSeen,
  SWITCH_MODES,
  type SwitchMode,
  safeLocalStorage,
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
  onSelect: (mode: SwitchMode, modelRef?: string) => Promise<DefaultSaved>;
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
  const [notSaved, setNotSaved] = useState(false);

  const choose = async (next: SwitchMode, pinned?: string): Promise<void> => {
    setError(null);
    setNotSaved(false);
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
      const saved = await onSelect(next, pinned);
      if (saved === "failed") setNotSaved(true);
      if (next === "auto" && !autoExplainerSeen(safeLocalStorage())) setExplainer(true);
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
      <SegmentedRadio<SwitchMode>
        label={t("chat.modeSwitch.label")}
        options={SWITCH_MODES.map((m) => ({ value: m, label: LABEL[m]() }))}
        // Plan (or anything else) selects no segment.
        value={mode as SwitchMode}
        disabled={disabled || busy}
        onChange={(m) => void choose(m)}
        className="w-fit"
      />
      {offer !== null ? (
        <p
          className="flex flex-wrap items-center gap-2 text-callout text-label-secondary"
          role="status"
          data-testid="mode-switch-offer"
        >
          {suggestion === null ? (
            // "Add its key" only once `models.list` has said what is configured.
            listed === undefined ? (
              offer.model === null ? (
                t("chat.modeSwitch.needsModel")
              ) : (
                t("chat.modeSwitch.autoUnavailable", { model: shortModel(offer.model) })
              )
            ) : (
              t("chat.modeSwitch.noModel")
            )
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
              markAutoExplainerSeen(safeLocalStorage());
              setExplainer(false);
            }}
          >
            {t("chat.modeSwitch.gotIt")}
          </button>
        </p>
      ) : null}
      {notSaved ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("chat.modeSwitch.notSaved")}
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
