import { type ChangeEvent, type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import { describeError } from "../../i18n/errors.ts";
import type { ImportedMemory, ImportSource, OnboardingExtrasProps } from "./types.ts";

const FORMATS: readonly ImportSource[] = ["chatgpt", "claude", "text"];

/**
 * Bring your memory: paste or upload what ChatGPT or Claude knows about the owner, parse it, and
 * show every item for review. Nothing is saved until "Save to memory"; a flagged item (it reads
 * like an instruction) starts unchecked.
 */
export function MemoryImportStep({
  onPreview,
  onCommit,
}: {
  onPreview?: OnboardingExtrasProps["onPreviewImport"];
  onCommit?: OnboardingExtrasProps["onCommitImport"];
}): ReactElement {
  const [format, setFormat] = useState<ImportSource>("text");
  const [text, setText] = useState("");
  const [items, setItems] = useState<ImportedMemory[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!onPreview || !onCommit) {
    return (
      <p className="text-reading text-label-secondary" data-testid="onboarding-memory">
        {t("onboarding.memory.unavailable")}
      </p>
    );
  }

  const readFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  };
  const parse = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const preview = await onPreview(format, text);
      setItems(preview.items);
      setSkipped(preview.skipped);
      setChecked(new Set(preview.items.filter((i) => !i.flagged).map((i) => i.id)));
    } catch (err) {
      setError(t("onboarding.memory.failed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setSaved(await onCommit((items ?? []).filter((i) => checked.has(i.id))));
      setItems(null);
      setText("");
    } catch (err) {
      setError(t("onboarding.memory.failed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-memory">
      <p className="text-reading text-label-secondary">{t("onboarding.memory.lead")}</p>
      {items === null ? (
        <>
          <div role="radiogroup" aria-label={t("onboarding.memory.format")} className="flex gap-2">
            {FORMATS.map((f) => (
              <Button
                key={f}
                type="button"
                variant={format === f ? "secondary" : "plain"}
                role="radio"
                aria-checked={format === f}
                onClick={() => setFormat(f)}
              >
                {tk(`onboarding.memory.format.${f}`)}
              </Button>
            ))}
          </div>
          <Textarea
            aria-label={t("onboarding.memory.paste")}
            placeholder={t("onboarding.memory.placeholder")}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <label className="text-callout text-accent-text">
              {t("onboarding.memory.upload")}
              <input type="file" accept=".txt,.md,.json" className="sr-only" onChange={readFile} />
            </label>
            <span className="ms-auto" />
            <Button
              type="button"
              disabled={busy || text.trim() === ""}
              onClick={() => void parse()}
            >
              {t("onboarding.memory.review")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-callout text-label-secondary">
            {t("onboarding.memory.found", { n: items.length, skipped })}
          </p>
          <ul className="flex flex-col gap-2" aria-label={t("onboarding.memory.items")}>
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-3 rounded-lg bg-fill-quaternary p-3"
              >
                <Checkbox
                  aria-label={item.text}
                  checked={checked.has(item.id)}
                  onCheckedChange={(on) =>
                    setChecked((c) => {
                      const next = new Set(c);
                      if (on) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 text-body text-label-primary">{item.text}</span>
                {item.flagged ? (
                  <span className="text-callout text-warning-text">
                    {t("onboarding.memory.flagged")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" variant="plain" onClick={() => setItems(null)}>
              {t("onboarding.memory.edit")}
            </Button>
            <span className="ms-auto" />
            <Button type="button" disabled={busy || checked.size === 0} onClick={() => void save()}>
              {t("onboarding.memory.save", { n: checked.size })}
            </Button>
          </div>
        </>
      )}
      {saved !== null ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("onboarding.memory.saved", { n: saved })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
