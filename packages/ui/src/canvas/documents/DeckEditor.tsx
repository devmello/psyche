import {
  type ArtifactDeck,
  type ArtifactDeckTheme,
  type ArtifactOp,
  type ArtifactSlide,
  type ArtifactSlideLayout,
  parseDeck,
} from "@psyche/protocol";
import { ArrowDown, ArrowUp, Play, Plus, Trash2 } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { Presenter } from "./Presenter.tsx";
import { SlideView } from "./SlideView.tsx";

export interface DocumentEditorProps {
  title: string;
  content: string;
  /** The latest version, and not mid-save: the owner may edit. */
  editable: boolean;
  /** Sends the owner's edit as ops (a new version authored by the owner). */
  onCommit: (ops: ArtifactOp[]) => Promise<boolean | undefined>;
}

const LAYOUTS: ArtifactSlideLayout[] = ["title", "bullets", "image", "two-column", "blank"];
const THEMES: ArtifactDeckTheme[] = ["light", "dark", "contrast"];
const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/**
 * The slide editor: a rail of slides, the selected slide's preview and fields, a theme, and the
 * presenter view. Every change is one op (`updateSlide`, `addSlide`, `moveSlide`…) on the version
 * on screen, so it merges with the agent's patches by slide id instead of replacing the deck.
 */
export default function DeckEditor({
  title,
  content,
  editable,
  onCommit,
}: DocumentEditorProps): ReactElement {
  const parsed = useMemo((): ArtifactDeck | null => {
    try {
      return parseDeck(content);
    } catch {
      return null;
    }
  }, [content]);
  const [pick, setPick] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  if (parsed === null)
    return (
      <p className="text-callout text-label-secondary" role="status">
        {t("canvas.invalid", { kind: "slides" })}
      </p>
    );
  const deck = parsed;
  const slide = deck.slides.find((s) => s.id === pick) ?? deck.slides[0];
  const index = slide === undefined ? -1 : deck.slides.indexOf(slide);
  const send = (...ops: ArtifactOp[]) => void onCommit(ops);

  const addSlide = () => {
    const id = `s${Date.now().toString(36)}`;
    send({
      op: "addSlide",
      slide: { id, layout: "bullets", title: "", bullets: [] },
      at: index + 1,
    });
    setPick(id);
  };

  return (
    <section aria-label={t("deck.label", { title })} className="flex h-full min-h-0 gap-4">
      <nav
        className="flex w-36 shrink-0 flex-col gap-2 overflow-auto"
        aria-label={t("deck.slides")}
      >
        <ol className="space-y-2">
          {deck.slides.map((s, n) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setPick(s.id)}
                aria-label={t("deck.slide", { n: n + 1 })}
                aria-current={s.id === slide?.id ? "true" : undefined}
                className={cn(
                  "block w-full rounded-sm p-0.5 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  s.id === slide?.id ? "ring-2 ring-accent-8" : "ring-1 ring-separator",
                )}
              >
                <SlideView slide={s} theme={deck.theme} />
                <span className="block truncate px-1 text-callout text-label-secondary">
                  {n + 1}. {s.title || t("deck.untitled")}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {editable ? (
          <Button size="sm" variant="secondary" onClick={addSlide}>
            <Plus aria-hidden="true" /> {t("deck.add")}
          </Button>
        ) : null}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-callout text-label-secondary">
            <span aria-hidden="true">{t("deck.theme")}</span>
            <NativeSelect
              aria-label={t("deck.theme")}
              size="sm"
              value={deck.theme}
              disabled={!editable}
              onChange={(e) => send({ op: "setTheme", theme: e.target.value as ArtifactDeckTheme })}
            >
              {THEMES.map((th) => (
                <option key={th} value={th}>
                  {t(`deck.theme.${th}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <span className="flex-1" />
          <Button size="sm" disabled={deck.slides.length === 0} onClick={() => setPresenting(true)}>
            <Play aria-hidden="true" /> {t("deck.present")}
          </Button>
        </div>
        {slide === undefined ? (
          <p className="text-callout text-label-secondary">{t("deck.empty")}</p>
        ) : (
          <>
            <SlideView slide={slide} theme={deck.theme} className="max-w-3xl shadow-sm" />
            <SlideFields
              // A new slide, or a new version of it, reloads the fields.
              key={`${slide.id}:${JSON.stringify(slide)}`}
              slide={slide}
              editable={editable}
              onChange={(changes) => send({ op: "updateSlide", id: slide.id, changes })}
              actions={
                editable ? (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("deck.moveUp")}
                      disabled={index === 0}
                      onClick={() => send({ op: "moveSlide", id: slide.id, to: index - 1 })}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("deck.moveDown")}
                      disabled={index === deck.slides.length - 1}
                      onClick={() => send({ op: "moveSlide", id: slide.id, to: index + 1 })}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("deck.remove")}
                      onClick={() => send({ op: "removeSlide", id: slide.id })}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </>
                ) : null
              }
            />
          </>
        )}
      </div>
      {presenting ? (
        <Presenter deck={deck} start={Math.max(0, index)} onExit={() => setPresenting(false)} />
      ) : null}
    </section>
  );
}

function SlideFields({
  slide,
  editable,
  onChange,
  actions,
}: {
  slide: ArtifactSlide;
  editable: boolean;
  onChange: (changes: Record<string, unknown>) => void;
  actions: ReactElement | null;
}): ReactElement {
  const text = (k: "title" | "image" | "notes", v: string) => {
    if (v !== (slide[k] ?? "")) onChange({ [k]: v === "" ? null : v });
  };
  const list = (k: "bullets" | "bullets2", v: string) => {
    if (v !== (slide[k] ?? []).join("\n")) onChange({ [k]: v.trim() === "" ? null : lines(v) });
  };
  return (
    <div className="grid max-w-3xl gap-3">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1 text-callout text-label-secondary">
          <span aria-hidden="true">{t("deck.layout")}</span>
          <NativeSelect
            aria-label={t("deck.layout")}
            size="sm"
            value={slide.layout}
            disabled={!editable}
            onChange={(e) => onChange({ layout: e.target.value })}
          >
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {t(`deck.layout.${l}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <span className="flex-1" />
        {actions}
      </div>
      <div className="flex flex-col gap-1 text-callout text-label-secondary">
        <span aria-hidden="true">{t("deck.field.title")}</span>
        <Input
          aria-label={t("deck.field.title")}
          defaultValue={slide.title ?? ""}
          readOnly={!editable}
          onBlur={(e) => text("title", e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1 text-callout text-label-secondary">
        <span aria-hidden="true">{t("deck.field.bullets")}</span>
        <Textarea
          aria-label={t("deck.field.bullets")}
          rows={4}
          defaultValue={(slide.bullets ?? []).join("\n")}
          readOnly={!editable}
          onBlur={(e) => list("bullets", e.target.value)}
        />
      </div>
      {slide.layout === "two-column" ? (
        <div className="flex flex-col gap-1 text-callout text-label-secondary">
          <span aria-hidden="true">{t("deck.field.bullets2")}</span>
          <Textarea
            aria-label={t("deck.field.bullets2")}
            rows={4}
            defaultValue={(slide.bullets2 ?? []).join("\n")}
            readOnly={!editable}
            onBlur={(e) => list("bullets2", e.target.value)}
          />
        </div>
      ) : null}
      {slide.layout === "image" ? (
        <div className="flex flex-col gap-1 text-callout text-label-secondary">
          <span aria-hidden="true">{t("deck.field.image")}</span>
          <Input
            aria-label={t("deck.field.image")}
            defaultValue={slide.image ?? ""}
            readOnly={!editable}
            onBlur={(e) => text("image", e.target.value)}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1 text-callout text-label-secondary">
        <span aria-hidden="true">{t("deck.field.notes")}</span>
        <Textarea
          aria-label={t("deck.field.notes")}
          rows={3}
          defaultValue={slide.notes ?? ""}
          readOnly={!editable}
          onBlur={(e) => text("notes", e.target.value)}
        />
      </div>
    </div>
  );
}
