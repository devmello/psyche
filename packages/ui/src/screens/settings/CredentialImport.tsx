import type { CredentialMeta } from "@psyche/protocol";
import { FileUp } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { ErrorNotice, messageOf } from "./shared.tsx";

/**
 * CSV import (feature G3) from a 1Password, Bitwarden or Chrome export. The file's text goes to
 * `vault.import` once, which parses it in the vault (packages/vault) and skips refused rows;
 * this form never keeps it.
 */

export type ImportFormat = "auto" | "1password" | "bitwarden" | "chrome";

export interface ImportOutcome {
  imported: readonly CredentialMeta[];
  skipped: readonly { row: number; reason: string }[];
}

/** `vault.import` accepts at most 10 M characters of CSV. */
export const IMPORT_MAX_BYTES = 10_000_000;

const FORMATS: readonly { value: ImportFormat; label: () => string }[] = [
  { value: "auto", label: () => t("settings.credentials.import.detect") },
  // Product names, the same in every language.
  { value: "1password", label: () => "1Password" },
  { value: "bitwarden", label: () => "Bitwarden" },
  { value: "chrome", label: () => "Chrome" },
];

const SKIPPED_SHOWN = 20;

export function ImportSummary({ outcome }: { outcome: ImportOutcome }): ReactElement {
  const { imported, skipped } = outcome;
  return (
    <div role="status" className="flex flex-col gap-1 rounded-md bg-gray-3 px-3 py-2">
      <p>
        {t("settings.credentials.import.summary", {
          imported: imported.length,
          skipped: skipped.length,
        })}
      </p>
      {skipped.length > 0 ? (
        <ul className="text-xs text-muted-foreground">
          {skipped.slice(0, SKIPPED_SHOWN).map((s) => (
            <li key={s.row}>
              {t("settings.credentials.import.row", { row: s.row, reason: s.reason })}
            </li>
          ))}
          {skipped.length > SKIPPED_SHOWN ? (
            <li>{t("settings.credentials.import.more", { n: skipped.length - SKIPPED_SHOWN })}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export interface ImportCredentialsFormProps {
  /** Sends the CSV to the vault; rejects with an Error whose message is shown. */
  onImport: (format: ImportFormat, csv: string) => Promise<ImportOutcome>;
  onClose: () => void;
  /** Stories: open showing this result. */
  defaultOutcome?: ImportOutcome;
}

export function ImportCredentialsForm({
  onImport,
  onClose,
  defaultOutcome,
}: ImportCredentialsFormProps): ReactElement {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<ImportFormat>("auto");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(defaultOutcome ?? null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (file === null || busy) return;
    setError(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setError(t("settings.credentials.import.tooLarge", { mb: IMPORT_MAX_BYTES / 1_000_000 }));
      return;
    }
    setBusy(true);
    try {
      const result = await onImport(format, await file.text());
      setOutcome(result);
      setFile(null);
      if (input.current) input.current.value = "";
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label={t("settings.credentials.import.form")}
      className="flex flex-col gap-3 rounded-md border border-gray-6 bg-background p-3"
    >
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <FileUp className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t("settings.credentials.import.explainer")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-file`}>{t("settings.credentials.import.file")}</Label>
          <Input
            ref={input}
            id={`${id}-file`}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setOutcome(null);
              setError(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-format`}>{t("settings.credentials.import.from")}</Label>
          <NativeSelect
            id={`${id}-format`}
            className="min-w-48"
            value={format}
            onChange={(e) => setFormat(e.target.value as ImportFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label()}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {error ? (
        <ErrorNotice what={error} did={t("settings.credentials.import.nothingImported")} />
      ) : null}
      {outcome ? <ImportSummary outcome={outcome} /> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={file === null || busy}>
          {busy
            ? t("settings.credentials.import.importing")
            : t("settings.credentials.import.submit")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {outcome ? t("common.done") : t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
