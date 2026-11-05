import type { SpeechEngineStatus } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { useSpeechEngine } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { Group, StatusChip } from "./shared.tsx";

/**
 * The on-device speech model where Psyche provisions it (Windows, `speech.engine.status`
 * `whisper`): until it is installed dictation uses the helper's SAPI, so Settings → Voice &
 * dictation and onboarding offer the one-click download with its size; while it downloads they
 * show the progress (`speech.model_download`); then which engine dictation uses. Nothing shows
 * where the Gateway does not provision whisper.cpp (the Mac's own engines need no download).
 */

const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

/** `whisper-base.en` → `base.en`. */
const modelName = (id: string) => id.replace(/^whisper-/, "");

export interface SpeechModelPanelProps {
  status: SpeechEngineStatus | undefined;
  downloading?: boolean;
  downloadError?: string | null;
  onDownload?: () => void;
}

export function SpeechModelPanel({
  status,
  downloading = false,
  downloadError = null,
  onDownload,
}: SpeechModelPanelProps): ReactElement | null {
  const w = status?.whisper;
  if (w === undefined || w === null) return null;
  const busy = downloading || w.state === "downloading";
  if (busy) {
    const total = w.totalBytes ?? w.downloadBytes;
    const received = w.receivedBytes ?? 0;
    const text = t("settings.voice.model.downloading", {
      received: Math.round(received / 1_000_000),
      total: mb(total),
    });
    return (
      <div className="flex flex-col gap-2" role="status" data-testid="speech-model">
        <span className="text-callout text-label-secondary">{text}</span>
        <Progress value={total > 0 ? Math.round((received / total) * 100) : 0} aria-label={text} />
      </div>
    );
  }
  if (w.state === "ready") {
    const first = status?.active === "whisper";
    const problem =
      w.serverError === "vcredist_missing"
        ? t("settings.voice.model.vcredist")
        : w.serverError === "crash_loop"
          ? t("settings.voice.model.crashed")
          : null;
    return (
      <div className="flex flex-col gap-1.5" data-testid="speech-model">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={problem === null ? "success" : "danger"}>
            {t("settings.voice.model.ready", { model: modelName(w.model.id) })}
          </StatusChip>
        </div>
        <p className="text-callout text-label-secondary">
          {problem ??
            (first ? t("settings.voice.model.readyHint") : t("settings.voice.model.readyNotFirst"))}
        </p>
      </div>
    );
  }
  const failed = downloadError ?? (w.state === "error" ? (w.error ?? "") : null);
  return (
    <div className="flex flex-col gap-2" data-testid="speech-model">
      <p className="text-reading text-label-secondary">{t("settings.voice.model.usingHelper")}</p>
      {failed !== null ? (
        <span role="alert">
          <StatusChip tone="danger">
            {t("settings.voice.model.failed", { reason: failed })}
          </StatusChip>
        </span>
      ) : null}
      {onDownload ? (
        <div>
          <Button
            type="button"
            variant={failed === null ? "default" : "outline"}
            onClick={onDownload}
          >
            {failed === null
              ? t("settings.voice.model.download", { mb: mb(w.downloadBytes) })
              : t("settings.voice.model.retry")}
          </Button>
        </div>
      ) : null}
      <p className="text-callout text-label-secondary">{t("settings.voice.model.downloadHint")}</p>
    </div>
  );
}

/**
 * Onboarding's row (the Windows access card in the Safety step, next to the microphone): the
 * same offer under a title, or nothing where there is none.
 */
export function SpeechModelRow(): ReactElement | null {
  const s = useSpeechEngine();
  if (s.status?.whisper === undefined || s.status.whisper === null) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="onboarding-speech-model">
      <span className="font-medium">{t("settings.voice.model.title")}</span>
      <SpeechModelPanel
        status={s.status}
        downloading={s.downloading}
        downloadError={s.downloadError}
        onDownload={() => void s.download()}
      />
    </div>
  );
}

/** Settings → Voice & dictation: the offer under its own heading, when there is one. */
export function SpeechModelGroup({
  status: override,
}: {
  /** Overrides the live status (stories, tests). */
  status?: SpeechEngineStatus;
} = {}): ReactElement | null {
  const s = useSpeechEngine();
  const status = override ?? s.status;
  if (status?.whisper === undefined || status.whisper === null) return null;
  return (
    <Group title={t("settings.voice.model.title")}>
      <SpeechModelPanel
        status={status}
        downloading={override === undefined && s.downloading}
        downloadError={override === undefined ? s.downloadError : null}
        onDownload={() => void s.download()}
      />
    </Group>
  );
}
