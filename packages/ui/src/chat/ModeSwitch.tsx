import type { PermissionMode } from "@psyche/protocol";
import { ChevronDown, ShieldCheck, ShieldOff } from "lucide-react";
import { type ReactElement, useState } from "react";
import { MODE_LABEL } from "../agent/AgentHeader.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import {
  applyModeChoice,
  autoModeBlockedBy,
  autoModeSuggestion,
  type DefaultSaved,
  isAutoModelRefusal,
  isSwitchMode,
  type ListedModels,
  SWITCH_MODES,
  type SwitchMode,
  shortModel,
} from "./mode-switch.ts";

export interface ModeChoiceOptions {
  /** The thread's pinned model; null when it follows the primary role. */
  modelRef: string | null;
  /** `models.list`, once loaded. */
  listed: ListedModels | undefined;
  /**
   * Applies the choice (this chat, and the default for new ones). `modelRef` is set when the
   * owner took the offer to switch models. Rejects with the Gateway's error.
   */
  onSelect: (mode: SwitchMode, modelRef?: string) => Promise<DefaultSaved>;
}

export interface ModeChoice {
  /** Picks a mode; Auto on a model that cannot run it becomes an offer instead. */
  choose: (mode: SwitchMode, pinned?: string) => Promise<void>;
  busy: boolean;
  /** Auto was refused for this model (null: the thread follows the primary role). */
  offer: { model: string | null } | null;
  /** The nearest model Auto allows, once an offer is showing. */
  suggestion: string | null;
  listed: ListedModels | undefined;
  /** The default for new chats could not be saved (a device without admin rights). */
  notSaved: boolean;
  error: string | null;
}

/**
 * The rules behind the one mode control (the picker in the composer bar): Manual / Balanced / Auto in one
 * choice. Auto on a model that cannot run it turns into an offer, "Switch to <model> and use
 * Auto"; a Gateway refusal becomes the same offer. The menu itself explains Auto, so nothing
 * here needs a first-time explainer.
 */
export function useModeChoice({ modelRef, listed, onSelect }: ModeChoiceOptions): ModeChoice {
  const [offer, setOffer] = useState<{ model: string | null } | null>(null);
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
    } catch (err) {
      const refusal = isAutoModelRefusal(err);
      if (refusal !== null) setOffer(refusal);
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return {
    choose,
    busy,
    offer,
    suggestion: offer === null ? null : autoModeSuggestion(listed, modelRef),
    listed,
    notSaved,
    error,
  };
}

/**
 * The mode choice for one open thread, wired to the Gateway: the chat changes first, and the main
 * chat's choice also becomes the default for new chats (`applyModeChoice`). The composer's picker
 * calls `choose`; `<ModeFeedback>` shows what it has to say.
 */
export function useThreadModeChoice(thread: {
  id: string | null;
  kind?: string | undefined;
  modelRef?: string | null | undefined;
}): ModeChoice {
  const call = useCall();
  const models = useGatewayQuery("models.list", {});
  return useModeChoice({
    modelRef: thread.modelRef ?? null,
    listed: models.data,
    onSelect: (mode, ref) => {
      if (thread.id === null) return Promise.resolve("skipped");
      return applyModeChoice(
        (method, params) => call(method as "threads.update", params as { threadId: string }),
        { id: thread.id, ...(thread.kind === undefined ? {} : { kind: thread.kind }) },
        mode,
        ref,
      );
    },
  });
}

/**
 * What a mode choice has to say, under the header and only while it has something to say: the
 * Auto offer with its one-tap model switch, "not saved as the default", or the Gateway's error.
 */
export function ModeFeedback({ choice }: { choice: ModeChoice }): ReactElement | null {
  const { offer, suggestion, listed, notSaved, error, choose } = choice;
  if (offer === null && !notSaved && error === null) return null;
  return (
    <div className="flex flex-col gap-1.5 px-4 pb-2" data-testid="mode-switch">
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

const MODE_DETAIL: Record<SwitchMode, () => string> = {
  manual: () => t("chat.args.mode.manual"),
  balanced: () => t("chat.args.mode.balanced"),
  auto: () => t("chat.args.mode.auto"),
  full: () => t("chat.args.mode.full"),
};

/**
 * The one permission control, a pop-up button in the composer bar that always shows the current
 * mode (like Xcode's scheme picker). The same four choices, in the same order, as `/mode` and
 * Settings: Manual, Balanced, Auto, Full access. Auto on a model that cannot run it becomes an
 * offer (`ModeFeedback`); Full access takes one pick, as it did in the header menu.
 */
export function ModePicker({
  mode,
  choice,
  disabled = false,
  shortcut,
}: {
  mode: PermissionMode;
  choice: ModeChoice;
  disabled?: boolean;
  /** The shortcut shown next to the menu's title. */
  shortcut?: string;
}): ReactElement {
  const full = mode === "full";
  const Icon = full ? ShieldOff : ShieldCheck;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 cursor-default gap-1 rounded-full px-2 text-callout text-label-secondary"
            aria-label={t("chat.modePicker.aria", { mode: MODE_LABEL[mode] })}
            aria-keyshortcuts="Meta+Shift+M"
            disabled={disabled || choice.busy}
            data-testid="mode-picker"
          />
        }
      >
        <Icon className={full ? "size-4 text-warning-text" : "size-4"} aria-hidden="true" />
        <span>{MODE_LABEL[mode]}</span>
        <ChevronDown className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-72 min-w-56 bg-popover! backdrop-blur-none!"
      >
        <DropdownMenuGroup data-testid="mode-menu">
          <DropdownMenuLabel className="flex items-center justify-between gap-4">
            {t("chat.modeSwitch.label")}
            {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={mode}
            onValueChange={(next) => {
              if (isSwitchMode(next)) void choice.choose(next);
            }}
          >
            {SWITCH_MODES.map((choiceMode) => (
              <DropdownMenuRadioItem key={choiceMode} value={choiceMode}>
                <span className="flex min-w-0 flex-col">
                  {MODE_LABEL[choiceMode]}
                  <span className="text-callout whitespace-normal text-label-secondary">
                    {MODE_DETAIL[choiceMode]()}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
