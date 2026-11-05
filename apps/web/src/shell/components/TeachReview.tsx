import type { SkillDraft } from "@psyche/protocol";
import { t, useSlots } from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import { useShell } from "../context.tsx";
import type { BrowserPort, TeachCapture } from "../platform.ts";
import {
  isTyped,
  moveStep,
  patchStep,
  type ReviewStep,
  removeStep,
  reviewFrom,
  reviewProblems,
  setChoice,
  toSaveSteps,
  type ValueChoice,
} from "./teach-review.ts";

/**
 * The review screen after Stop (teach by showing, design doc §3): the steps in plain words, which
 * the owner can edit, reorder, delete and mark as inputs. Save makes a skill draft through the
 * existing owner-approved path and opens the usual approval card; nothing runs until it is
 * approved. The recording is gone after Save unless the owner asked to keep it.
 */

const addressOf = (url: string | undefined) => (url ?? "").replace(/^https?:\/\//, "");

/** One step in plain words. */
export function stepWords(s: ReviewStep): string {
  const field = s.name ?? t("web.teach.step.typeUnnamed");
  const value = s.sample === undefined ? "" : `“${s.sample}”`;
  switch (s.kind) {
    case "navigate":
      return t("web.teach.step.navigate", { address: addressOf(s.url) });
    case "click":
      return s.name === undefined
        ? t("web.teach.step.clickRole", { role: s.role ?? "" })
        : t("web.teach.step.click", { name: s.name });
    case "press":
      return s.name === undefined
        ? t("web.teach.step.press", { key: s.key ?? "Enter" })
        : t("web.teach.step.pressIn", { key: s.key ?? "Enter", name: s.name });
    case "select":
      if (s.sensitive) return t("web.teach.step.selectSensitive", { name: field });
      if (s.choice === "keep") return t("web.teach.step.selectKept", { value, name: field });
      if (s.choice === "input")
        return t("web.teach.step.selectInput", { input: s.inputName, name: field });
      return t("web.teach.step.selectAsk", { name: field });
    default:
      if (s.sensitive) return t("web.teach.step.typeSensitive", { name: field });
      if (s.choice === "keep") return t("web.teach.step.typeKept", { value, name: field });
      if (s.choice === "input")
        return t("web.teach.step.typeInput", { input: s.inputName, name: field });
      return t("web.teach.step.typeAsk", { name: field });
  }
}

export function TeachReview(props: {
  capture: TeachCapture;
  /** Set when the owner opened a kept recording: its steps are the starting point. */
  initial?: ReviewStep[];
  initialTitle?: string;
  port: BrowserPort;
  onClose: () => void;
}): ReactElement {
  const { store } = useShell();
  const { prefillComposer } = useSlots();
  const [rows, setRows] = useState<ReviewStep[]>(() => props.initial ?? reviewFrom(props.capture));
  const [title, setTitle] = useState(props.initialTitle ?? "");
  const [keep, setKeep] = useState(false);
  // Kept recordings are encrypted; with no keychain none is kept (the box is off and says why).
  const [canKeep, setCanKeep] = useState(true);
  useEffect(() => {
    let live = true;
    props.port.teachStorage?.().then(
      (s) => live && setCanKeep(s.encrypted),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [props.port]);
  const [phase, setPhase] = useState<"review" | "saving" | "saved">("review");
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The skill is installed once the owner approves the card: watch the draft.
  useEffect(() => {
    if (draft === null) return;
    return store.tap((e) => {
      if (e.event !== "skills.draft.updated") return;
      const d = (e.payload as { draft?: SkillDraft } | undefined)?.draft;
      if (d?.id === draft.id && d.status === "installed") setInstalled(true);
    });
  }, [store, draft]);

  const problems = reviewProblems(rows);

  const save = async () => {
    setError(null);
    if (title.trim() === "") {
      setError(t("web.teach.review.needName"));
      return;
    }
    if (problems.length > 0) {
      setError(t("web.teach.review.issues", { problems: problems.join("; ") }));
      return;
    }
    setPhase("saving");
    const steps = toSaveSteps(rows);
    try {
      const made = await store.call<{ draft: SkillDraft }>("skills.drafts.fromRecording", {
        title: title.trim(),
        steps,
      });
      if (made === undefined) throw new Error("no answer");
      // The usual approval card: replay check, trust card, device-only skill_install.
      await store.call("skills.drafts.accept", { draftId: made.draft.id });
      if (keep && canKeep && props.port.teachKeep) {
        await props.port.teachKeep(props.capture.id, title.trim(), steps).catch(() => {
          store.toast(t("web.teach.kept.failed"), "warn");
        });
      }
      setDraft(made.draft);
      setRows([]);
      setPhase("saved");
      void store.refresh();
    } catch (err) {
      setPhase("review");
      setError(
        t("web.teach.review.saveFailed", { reason: err instanceof Error ? err.message : "" }),
      );
    }
  };

  const discard = () => {
    setRows([]);
    props.onClose();
  };

  if (phase === "saved" && draft !== null) {
    return (
      <section
        className="teach-review"
        aria-label={t("web.teach.done.title")}
        data-testid="teach-done"
      >
        <h2>{t("web.teach.done.title")}</h2>
        <p>
          {installed
            ? t("web.teach.done.installed", { title: title.trim() })
            : t("web.teach.done.body", { title: title.trim() })}
        </p>
        {installed ? <p className="teach-hint">{t("web.teach.done.runHint")}</p> : null}
        <div className="teach-actions">
          {installed ? (
            <button
              type="button"
              className="teach-primary"
              data-testid="teach-run"
              onClick={() => {
                prefillComposer?.(`/${draft.name}`);
                props.onClose();
              }}
            >
              {t("web.teach.done.run")}
            </button>
          ) : null}
          <button type="button" className="pill" onClick={props.onClose}>
            {t("web.teach.done.close")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      className="teach-review"
      aria-label={t("web.teach.review.title")}
      data-testid="teach-review"
    >
      <h2>{t("web.teach.review.title")}</h2>
      <p className="teach-hint">{t("web.teach.review.intro")}</p>
      <label className="teach-field">
        <span>{t("web.teach.review.name")}</span>
        <input
          value={title}
          maxLength={120}
          placeholder={t("web.teach.review.namePlaceholder")}
          data-testid="teach-title"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {(props.capture.skippedNavigations ?? 0) > 0 ? (
        <p className="teach-hint" data-testid="teach-skipped">
          {t("web.teach.review.skipped", { count: props.capture.skippedNavigations ?? 0 })}
        </p>
      ) : null}
      <h3>{t("web.teach.review.steps")}</h3>
      {rows.length === 0 ? <p className="teach-hint">{t("web.teach.review.empty")}</p> : null}
      <ol className="teach-steps">
        {rows.map((s, i) => (
          <li key={s.id} className="teach-step" data-testid="teach-step" data-kind={s.kind}>
            <div className="teach-step-head">
              <span className="teach-words" data-testid="teach-words">
                {stepWords(s)}
              </span>
              <span className="teach-step-tools">
                <button
                  type="button"
                  className="pill"
                  disabled={i === 0}
                  aria-label={t("web.teach.review.moveUp", { n: i + 1 })}
                  onClick={() => setRows((r) => moveStep(r, i, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="pill"
                  disabled={i === rows.length - 1}
                  aria-label={t("web.teach.review.moveDown", { n: i + 1 })}
                  onClick={() => setRows((r) => moveStep(r, i, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="pill"
                  aria-label={t("web.teach.review.remove", { n: i + 1 })}
                  data-testid="teach-remove"
                  onClick={() => setRows((r) => removeStep(r, i))}
                >
                  ×
                </button>
              </span>
            </div>
            {s.sensitive ? (
              <p className="teach-hint">{t("web.teach.review.sensitive")}</p>
            ) : isTyped(s) ? (
              <div className="teach-value">
                <label className="teach-field">
                  <span>{t("web.teach.review.value")}</span>
                  <select
                    value={s.choice}
                    data-testid="teach-choice"
                    onChange={(e) => setRows((r) => setChoice(r, i, e.target.value as ValueChoice))}
                  >
                    <option value="ask">{t("web.teach.review.value.ask")}</option>
                    {s.sample !== undefined ? (
                      <option value="keep">{t("web.teach.review.value.keep")}</option>
                    ) : null}
                    <option value="input">{t("web.teach.review.value.input")}</option>
                  </select>
                </label>
                {s.choice === "keep" && s.sample !== undefined ? (
                  <p className="teach-hint">
                    {t("web.teach.review.valueKept", { value: `“${s.sample}”` })}
                  </p>
                ) : null}
                {s.choice === "ask" ? (
                  <p className="teach-hint">{t("web.teach.review.valueHidden")}</p>
                ) : null}
                {s.choice === "input" ? (
                  <>
                    <label className="teach-field">
                      <span>{t("web.teach.review.inputName")}</span>
                      <input
                        value={s.inputName}
                        maxLength={40}
                        data-testid="teach-input-name"
                        onChange={(e) =>
                          setRows((r) => patchStep(r, i, { inputName: e.target.value }))
                        }
                      />
                    </label>
                    <label className="teach-field">
                      <span>{t("web.teach.review.inputDescription")}</span>
                      <input
                        value={s.inputDescription}
                        maxLength={200}
                        placeholder={t("web.teach.review.inputDescriptionPlaceholder")}
                        onChange={(e) =>
                          setRows((r) => patchStep(r, i, { inputDescription: e.target.value }))
                        }
                      />
                    </label>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <label className="teach-check">
        <input
          type="checkbox"
          checked={keep && canKeep}
          disabled={!canKeep}
          data-testid="teach-keep"
          onChange={(e) => setKeep(e.target.checked)}
        />
        <span>{t("web.teach.review.keepRecording")}</span>
      </label>
      <p className="teach-hint">
        {canKeep ? t("web.teach.review.keepRecordingHint") : t("web.teach.review.keepUnavailable")}
      </p>
      <p className="teach-hint">{t("web.teach.review.privacy")}</p>
      {error !== null ? (
        <p role="alert" className="teach-error" data-testid="teach-error">
          {error}
        </p>
      ) : null}
      <div className="teach-actions">
        <button type="button" className="pill" onClick={discard} data-testid="teach-discard">
          {t("web.teach.review.discard")}
        </button>
        <button
          type="button"
          className="teach-primary"
          disabled={phase === "saving" || rows.length === 0}
          onClick={() => void save()}
          data-testid="teach-save"
        >
          {phase === "saving" ? t("web.teach.review.saving") : t("web.teach.review.save")}
        </button>
      </div>
    </section>
  );
}
