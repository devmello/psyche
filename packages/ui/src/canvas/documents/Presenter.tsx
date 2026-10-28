import type { ArtifactDeck } from "@psyche/protocol";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { SlideView } from "./SlideView.tsx";

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Presenter view: the current slide large, the next slide and the speaker notes beside it, a
 * timer, and the keyboard (←/→/space/Home/End, Esc to leave). It lives inside the canvas as a
 * dialog; nothing opens a second window.
 */
export function Presenter({
  deck,
  start = 0,
  onExit,
}: {
  deck: ArtifactDeck;
  start?: number;
  onExit: () => void;
}): ReactElement {
  const total = deck.slides.length;
  const [i, setI] = useState(Math.min(start, Math.max(0, total - 1)));
  const [seconds, setSeconds] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const go = (n: number) => setI(Math.max(0, Math.min(total - 1, n)));

  useEffect(() => {
    root.current?.focus();
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const slide = deck.slides[i];
  const next = deck.slides[i + 1];
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t("deck.presenter")}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col gap-3 bg-background p-4 outline-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") onExit();
        else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") go(i + 1);
        else if (e.key === "ArrowLeft" || e.key === "PageUp") go(i - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(total - 1);
        else return;
        e.preventDefault();
      }}
    >
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-headline">{t("deck.presenter")}</h2>
        <span className="text-callout text-label-secondary tabular-nums">
          {t("deck.elapsed", { time: clock(seconds) })}
        </span>
        <span className="text-callout text-label-secondary tabular-nums" aria-live="polite">
          {t("deck.position", { n: i + 1, total })}
        </span>
        <Button size="sm" variant="secondary" onClick={onExit}>
          <X aria-hidden="true" /> {t("deck.exit")}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[2fr_1fr]">
        <div className="flex min-h-0 items-center justify-center">
          {slide === undefined ? (
            <p className="text-label-secondary">{t("deck.empty")}</p>
          ) : (
            <SlideView slide={slide} theme={deck.theme} className="max-h-full shadow-md" />
          )}
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <section aria-label={t("deck.upNext")} className="space-y-1">
            <h3 className="text-callout font-semibold text-label-secondary">{t("deck.upNext")}</h3>
            {next === undefined ? (
              <p className="text-callout text-label-tertiary">{t("deck.noNext")}</p>
            ) : (
              <SlideView slide={next} theme={deck.theme} />
            )}
          </section>
          <section aria-label={t("deck.field.notes")} className="space-y-1">
            <h3 className="text-callout font-semibold text-label-secondary">
              {t("deck.field.notes")}
            </h3>
            <p className="whitespace-pre-wrap text-body">
              {slide?.notes ?? <span className="text-label-tertiary">{t("deck.noNotes")}</span>}
            </p>
          </section>
        </div>
      </div>
      <div className="flex justify-center gap-2">
        <Button size="sm" variant="secondary" disabled={i === 0} onClick={() => go(i - 1)}>
          <ChevronLeft aria-hidden="true" /> {t("deck.prev")}
        </Button>
        <Button size="sm" disabled={i >= total - 1} onClick={() => go(i + 1)}>
          {t("deck.next")} <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
