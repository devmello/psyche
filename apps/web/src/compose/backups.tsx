import type { BackupInfo } from "@psyche/protocol";
import {
  activeI18n,
  describeError,
  t,
  useCall,
  useGatewayQuery,
  usePersona,
  useSettingsForm,
} from "@psyche/ui";
import { type ReactElement, useId, useState } from "react";

/**
 * Backups (feature U4; docs/06 §3.18 Data controls): the archives `backup.*` manages under
 * `$PSYCHE_HOME/backups/`, "Back up now" with a passphrase that is sent once and never stored,
 * verify and delete per archive, and the schedule setting. Restore replaces the Gateway's own
 * state, so it stays a CLI step with the Gateway stopped; the panel shows the command.
 */

/** Schedule setting read by the Gateway's scheduler (S04 / S22): `{ interval, keep }`. */
export const BACKUP_SCHEDULE_KEY = "backup.schedule";
export type BackupInterval = "off" | "daily" | "weekly";
export interface BackupSchedule {
  interval: BackupInterval;
  /** Archives to keep; older ones are deleted after a successful scheduled backup. */
  keep: number;
}
export const DEFAULT_SCHEDULE: BackupSchedule = { interval: "off", keep: 7 };
export const MIN_PASSPHRASE = 12;

export function scheduleOf(values: Readonly<Record<string, unknown>>): BackupSchedule {
  const raw = values[BACKUP_SCHEDULE_KEY];
  if (typeof raw !== "object" || raw === null) return DEFAULT_SCHEDULE;
  const r = raw as Partial<BackupSchedule>;
  const interval: BackupInterval =
    r.interval === "daily" || r.interval === "weekly" ? r.interval : "off";
  const keep =
    typeof r.keep === "number" && Number.isInteger(r.keep) && r.keep >= 1 && r.keep <= 365
      ? r.keep
      : DEFAULT_SCHEDULE.keep;
  return { interval, keep };
}

export function formatBytes(n: number): string {
  const fixed = (v: number, digits: number) =>
    activeI18n().number(v, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (n < 1024) return t("web.bytes.b", { n: fixed(n, 0) });
  if (n < 1024 * 1024) return t("web.bytes.kb", { n: fixed(n / 1024, 0) });
  if (n < 1024 * 1024 * 1024) return t("web.bytes.mb", { n: fixed(n / (1024 * 1024), 1) });
  return t("web.bytes.gb", { n: fixed(n / (1024 * 1024 * 1024), 2) });
}

/** `true` when a Gateway error message says the method is not served yet (`unknown_method`). */
export function isUnavailableMessage(message: string | null): boolean {
  return message !== null && /unknown[ _]method|unavailable/i.test(message);
}

/** `true` for the error the kit raises when the Gateway lacks a method. */
export function isUnavailable(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  return (
    code === "unknown_method" ||
    code === "unavailable" ||
    isUnavailableMessage(err instanceof Error ? err.message : null)
  );
}

type BackupAction = "backup" | "verify" | "delete";

const button =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs hover:bg-gray-3 disabled:opacity-50";
const input = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export function BackupsPanel(): ReactElement {
  const id = useId();
  const persona = usePersona();
  const call = useCall();
  const form = useSettingsForm();
  const list = useGatewayQuery("backup.list", {});
  const [passphrase, setPassphrase] = useState("");
  const [unencrypted, setUnencrypted] = useState(false);
  const [busy, setBusy] = useState<BackupAction | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const schedule = scheduleOf(form.values);
  const unavailable = isUnavailableMessage(list.error);

  const run = async (what: BackupAction, fn: () => Promise<string>) => {
    setBusy(what);
    setNotice(null);
    try {
      setNotice({ kind: "ok", text: await fn() });
      list.reload();
    } catch (err) {
      setNotice({
        kind: "error",
        text: isUnavailable(err)
          ? t("web.backups.needsGateway", { command: "psyche backup create --stop" })
          : t("web.backups.failed", { action: what, error: describeError(err) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run("backup", async () => {
      const res = await call("backup.create", unencrypted ? { unencrypted: true } : { passphrase });
      setPassphrase("");
      return t("web.backups.created", { files: res.files, file: res.backup.file });
    });

  const verify = (b: BackupInfo) =>
    run("verify", async () => {
      const res = await call("backup.verify", {
        file: b.file,
        ...(b.encrypted && passphrase ? { passphrase } : {}),
      });
      return res.ok
        ? t("web.backups.verified", { file: b.file, files: res.files })
        : t("web.backups.problems", { file: b.file, problems: res.problems.join("; ") });
    });

  const remove = (b: BackupInfo) =>
    run("delete", async () => {
      await call("backup.delete", { file: b.file });
      return t("web.backups.deleted", { file: b.file });
    });

  const setSchedule = (next: Partial<BackupSchedule>) =>
    form.onChange(BACKUP_SCHEDULE_KEY, { ...schedule, ...next });

  const canCreate = busy === null && (unencrypted || passphrase.length >= MIN_PASSPHRASE);
  const backups = list.data?.backups ?? [];

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
      data-testid="settings-backups"
    >
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-foreground">
          {t("web.backups.title")}
        </h3>
        <p className="text-muted-foreground">
          {t("web.backups.description", { persona: persona.name })}
        </p>
      </div>
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "text-danger-text"
              : "rounded-md bg-gray-3 px-3 py-2 text-foreground"
          }
        >
          {notice.text}
        </p>
      ) : null}
      {unavailable ? (
        <p role="status" className="text-approval-text">
          {t("web.backups.needsGatewayMeanwhile")} <code>psyche backup create --stop</code>.
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-medium text-foreground">{t("web.backups.passphrase")}</span>
          <input
            type="password"
            className={input}
            autoComplete="new-password"
            value={passphrase}
            disabled={unencrypted}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-describedby={`${id}-pass-hint`}
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={unencrypted}
            onChange={(e) => setUnencrypted(e.target.checked)}
          />
          {t("web.backups.skipEncryption")}
        </label>
        <button
          type="button"
          className={button}
          disabled={!canCreate}
          onClick={() => void create()}
        >
          {busy === "backup" ? t("web.backups.backingUp") : t("web.backups.backUpNow")}
        </button>
      </div>
      <p id={`${id}-pass-hint`} className="text-xs text-muted-foreground">
        {t("web.backups.passphraseHint", { min: MIN_PASSPHRASE })}
      </p>

      {list.loading && backups.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {t("web.backups.loading")}
        </p>
      ) : backups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-6 p-3 text-muted-foreground">
          {t("web.backups.empty")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-6" aria-label={t("web.backups.title")}>
          {backups.map((b) => (
            <li key={b.file} className="flex flex-wrap items-center gap-3 py-1.5">
              <code className="min-w-0 flex-1 font-mono text-xs">{b.file}</code>
              <span className="text-xs text-muted-foreground">
                {t("web.backups.meta", {
                  created: activeI18n().dateTime(b.createdAt),
                  size: formatBytes(b.bytes),
                  encrypted: b.encrypted,
                })}
                {b.verifiedAt
                  ? t("web.backups.verifiedOn", { date: activeI18n().date(b.verifiedAt) })
                  : ""}
              </span>
              <button
                type="button"
                className={button}
                disabled={busy !== null}
                onClick={() => void verify(b)}
                aria-label={t("web.backups.verifyFile", { file: b.file })}
              >
                {t("web.backups.verify")}
              </button>
              <button
                type="button"
                className={button}
                disabled={busy !== null}
                onClick={() => void remove(b)}
                aria-label={t("web.backups.deleteFile", { file: b.file })}
              >
                {t("common.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <legend className="font-medium text-foreground">{t("web.backups.schedule")}</legend>
        {(["off", "daily", "weekly"] as const).map((v) => (
          <label key={v} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${id}-interval`}
              value={v}
              checked={schedule.interval === v}
              onChange={() => setSchedule({ interval: v })}
            />
            {t(`web.backups.interval.${v}`)}
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          {t("web.backups.keep")}
          <input
            type="number"
            className={`${input} w-16`}
            min={1}
            max={365}
            value={schedule.keep}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 365) setSchedule({ keep: n });
            }}
            aria-label={t("web.backups.keepLabel")}
          />
        </label>
      </fieldset>
      {form.needsApproval.has(BACKUP_SCHEDULE_KEY) ? (
        <p role="status" className="text-xs text-approval-text">
          {t("web.backups.needsApproval")}
        </p>
      ) : null}
      {form.writeError ? (
        <p role="alert" className="text-danger-text">
          {form.writeError}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t("web.backups.restore")}{" "}
        <code>psyche backup restore {list.data?.dir ?? "$PSYCHE_HOME/backups"}/&lt;file&gt;</code>
        {t("web.backups.restoreUnlock")}
      </p>
    </section>
  );
}
