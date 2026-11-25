import type { PointsRefusal, PointsState, PointsWindow } from "@psyche/protocol";
import { type ReactElement, useId } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { t } from "../i18n/core.ts";
import type { TccPermission, TccState } from "../screens/settings/types.ts";
import { HelperPermissionRow } from "./HelperPermissionRow.tsx";
import { PointsDataLine } from "./PointsDataLine.tsx";

/** The longest goal the Gateway takes (`POINTS_LIMITS.goalMax`). */
export const POINTS_GOAL_MAX = 500;

export type PointsWindowList =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; windows: readonly PointsWindow[] };

/** A running session, as the sheet's own row shows it (`points.status`, `points.updated`). */
export interface PointsSessionView {
  app: string;
  state: PointsState;
  step: number;
  of: number;
}

export interface PointsStartSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: PointsWindowList;
  onRetry: () => void;
  /** The ref of the chosen window. */
  selected: string | null;
  onSelect: (ref: string) => void;
  goal: string;
  onGoal: (goal: string) => void;
  /**
   * Psyche Helper's Accessibility, shown as the same row as Settings → Computer use while it is
   * missing. Absent when it is granted (or when the helper's state is not known yet).
   */
  accessibility?: { state: TccState; offline: boolean; onAllow: (p: TccPermission) => void };
  persona: string;
  /** The primary model's provider for the data line; absent says "your model provider". */
  provider?: string;
  /** The primary model runs on this computer. */
  local?: boolean;
  /** Psyche Helper's grants are still being read: Start waits. */
  checking?: boolean;
  starting: boolean;
  /** Start failed: shown under the buttons. */
  failed: boolean;
  onStart: () => void;
  session?: PointsSessionView;
  onStopSession: () => void;
}

const refusalText = (r: PointsRefusal): string => t(`points.refusal.${r}`);

function sessionLine(s: PointsSessionView): string {
  if (s.state === "pointing" && s.of > 0)
    return t("points.state.pointing", { step: s.step, of: s.of });
  if (s.state === "paused") return t("points.state.paused");
  return t("points.state.reading");
}

/**
 * The start sheet (docs/design/psyche-points-2026.md §6.2): the owner picks a window and says what
 * the form is for, then presses Start. It lists windows by app and title; a window Psyche refuses
 * stays listed with the reason. Under Start sits the line that says what goes to the model.
 */
export function PointsStartSheet({
  open,
  onOpenChange,
  list,
  onRetry,
  selected,
  onSelect,
  goal,
  onGoal,
  accessibility,
  persona,
  provider,
  local,
  checking = false,
  starting,
  failed,
  onStart,
  session,
  onStopSession,
}: PointsStartSheetProps): ReactElement {
  const goalId = useId();
  const windows = list.status === "ready" ? list.windows : [];
  const chosen = windows.find((w) => w.ref === selected);
  const canStart =
    session === undefined &&
    chosen !== undefined &&
    chosen.refusal === undefined &&
    accessibility === undefined &&
    !checking &&
    !starting;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="points-sheet" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("points.sheet.title")}</DialogTitle>
          <DialogDescription>{t("points.sheet.description")}</DialogDescription>
        </DialogHeader>

        {session ? (
          <div
            data-testid="points-session"
            className="flex flex-wrap items-center gap-2 rounded-md border border-gray-6 px-3 py-2"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body text-label-primary">
                {t("points.sheet.session.active", { app: session.app })}
              </span>
              <span role="status" className="text-callout text-label-secondary">
                {sessionLine(session)}
              </span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onStopSession}>
              {t("points.sheet.session.stop")}
            </Button>
          </div>
        ) : null}

        <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={session !== undefined}>
          <legend className="mb-1 text-callout text-label-secondary">
            {t("points.sheet.windows.label")}
          </legend>
          {list.status === "loading" ? (
            <p role="status" className="text-callout text-label-secondary">
              {t("points.sheet.windows.loading")}
            </p>
          ) : list.status === "error" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-callout text-danger-text">
                {t("points.sheet.windows.error")}
              </p>
              <Button type="button" variant="outline" size="xs" onClick={onRetry}>
                {t("points.sheet.windows.retry")}
              </Button>
            </div>
          ) : windows.length === 0 ? (
            <p className="text-callout text-label-secondary">{t("points.sheet.windows.empty")}</p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {windows.map((w) => {
                const id = `${goalId}-${w.ref}`;
                return (
                  <li key={w.ref}>
                    <label
                      htmlFor={id}
                      className={`flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-gray-3 ${
                        w.refusal === undefined ? "cursor-pointer" : "opacity-70"
                      }`}
                    >
                      <input
                        id={id}
                        type="radio"
                        name={`${goalId}-window`}
                        className="mt-1 accent-accent-9"
                        checked={selected === w.ref}
                        disabled={w.refusal !== undefined}
                        onChange={() => onSelect(w.ref)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body text-label-primary">
                          {w.app.name}
                          {w.frontmost ? (
                            <span className="ms-2 text-callout text-label-secondary">
                              {t("points.sheet.window.frontmost")}
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-callout text-label-secondary">
                          {w.title === "" ? t("points.sheet.window.untitled") : w.title}
                        </span>
                        {w.refusal ? (
                          <span className="text-callout text-label-secondary">
                            {refusalText(w.refusal)}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={goalId} className="text-callout text-label-secondary">
            {t("points.sheet.goal.label")}
          </label>
          <Textarea
            id={goalId}
            value={goal}
            maxLength={POINTS_GOAL_MAX}
            rows={2}
            placeholder={t("points.sheet.goal.placeholder")}
            disabled={session !== undefined}
            onChange={(e) => onGoal(e.target.value)}
          />
        </div>

        {accessibility ? (
          <div data-testid="points-permission" className="flex flex-col gap-1.5">
            <p className="text-callout text-label-secondary">{t("points.sheet.permission.hint")}</p>
            <HelperPermissionRow
              permission="accessibility"
              state={accessibility.state}
              persona={persona}
              offline={accessibility.offline}
              onAllow={accessibility.onAllow}
            />
          </div>
        ) : null}

        <p className="text-callout text-label-secondary">{t("points.sheet.payments")}</p>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col sm:items-stretch">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("points.sheet.cancel")}
            </Button>
            <Button type="button" disabled={!canStart} onClick={onStart}>
              {starting ? t("points.sheet.starting") : t("points.sheet.start")}
            </Button>
          </div>
          <PointsDataLine
            {...(provider === undefined ? {} : { provider })}
            {...(local ? { local } : {})}
          />
          {failed ? (
            <p role="alert" className="text-callout text-danger-text">
              {t("points.sheet.startFailed")}
            </p>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
