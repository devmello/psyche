import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { duration, ease, motionSpring, spring } from "../motion/tokens.ts";

/**
 * The startup splash's face (#595): a moth drawn in one ink line on the app's own paper. Its
 * wings open a step at a time as Psyche wakes (the only progress there is), the wordmark is
 * written beneath it in the notebook serif and three ruled marks say how far along the start is.
 * On pairing the moth flies into the chat toolbar's avatar (`[data-splash-target]`) while the
 * paper fades away under it, so splash and app read as one surface. A failed start folds the wings
 * and goes graphite. Reduced motion: the same drawing, static, and one crossfade out.
 *
 * Presentational: apps/web's `StartupSplash` decides the line, when to leave and the actions.
 * Compositor-only after the draw (opacity, transform); no glass, no glow, nothing idles.
 */

export interface SplashLineView {
  tone: "progress" | "ready" | "error";
  text: string;
  /** How far along the start is (tone "progress"): 0 setting up, 1 waking, 2 connecting. */
  step?: 0 | 1 | 2;
  /** Why the start failed (tone "error"). */
  reason?: string;
  /** Lines to compare or act on under the status (a pairing code and the Gateway's key). */
  detail?: readonly string[];
}

/** One more thing the owner can do from a failed or waiting start (remote Gateways). */
export interface SplashActionView {
  id: string;
  text: string;
  onClick: () => void;
  primary?: boolean;
}

export interface StartupSplashViewProps {
  line: SplashLineView;
  /** Paired: the splash is giving way to the app. */
  leaving?: boolean;
  /** The start is taking longer than usual: say so, and the app is one click away. */
  slow?: boolean;
  onShowLogs?: () => void;
  onRetry?: () => void;
  /** Shown when set: the owner can open the app behind a slow or failed start. */
  onOpenAnyway?: () => void;
  /** Other actions for this state, after Show logs and Try again. */
  actions?: readonly SplashActionView[];
  /** Content under the actions (the Gateway switcher a "Switch Gateway" action opened). */
  below?: ReactNode;
}

/** How long the hand-off takes (the caller unmounts after it). */
export const SPLASH_LEAVE_MS = duration.long;
/** Reduced motion: one opacity crossfade instead of the flight. */
export const SPLASH_LEAVE_REDUCED_MS = duration.short;

/** The stages of a start; "ready" is the stage after the last. */
const STEPS = 3;
/** How far the wings are open at each stage (folded at first, fully open when ready). */
const WINGS_OPEN = [0.4, 0.62, 0.82, 1] as const;

const seconds = (ms: number) => ms / 1000;
const EASE_ENTER: [number, number, number, number] = [...ease.enter];
const EASE_EXIT: [number, number, number, number] = [...ease.exit];

const GLYPH = 88;
const BODY = "M32 14.5C35.2 18 35.6 31 32 41C28.4 31 28.8 18 32 14.5Z";
const ANTENNA = "M33 15C34 10 37 6.5 42 5";
const FOREWING = "M33.5 22C37 13 47 9 58 13C60 21 52 29 34 30";
const HINDWING = "M34 30C43 30 52 35 49.5 43C43 46 36 41 33.5 35";
const VEIN = "M35 27C41 21 47 18 54 16";

interface Flight {
  x: number;
  y: number;
  scale: number;
}

/** Where the mark lands in the app: the centre and size of the toolbar avatar, if it's there. */
function flightTo(from: DOMRect): Flight | null {
  const el =
    typeof document === "undefined" ? null : document.querySelector("[data-splash-target]");
  const to = el?.getBoundingClientRect();
  if (!to || to.width === 0 || from.width === 0) return null;
  return {
    x: to.left + to.width / 2 - (from.left + from.width / 2),
    y: to.top + to.height / 2 - (from.top + from.height / 2),
    scale: to.width / from.width,
  };
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function StartupSplashView({
  line,
  leaving = false,
  slow = false,
  onShowLogs,
  onRetry,
  onOpenAnyway,
  actions,
  below,
}: StartupSplashViewProps): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  const markRef = useRef<HTMLDivElement>(null);
  /** undefined until measured on leaving; null when the avatar isn't there to fly to. */
  const [flight, setFlight] = useState<Flight | null | undefined>();
  const failed = line.tone === "error";

  // The start only moves forward: a status that steps back (the helper, then connecting) must not
  // fold the wings again. A failure resets it, so a retry wakes the moth from the start.
  const peak = useRef(0);
  const reached = line.tone === "ready" ? STEPS : (line.step ?? 0);
  peak.current = failed ? 0 : Math.max(peak.current, reached);
  const step = peak.current;

  useLayoutEffect(() => {
    if (!leaving || reduce || !markRef.current) return;
    setFlight(flightTo(markRef.current.getBoundingClientRect()));
  }, [leaving, reduce]);

  // The first stroke starts when the body fades in; each later one follows it.
  const base = seconds(duration.splashDelay);
  const draw = (order: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: {
            duration: seconds(duration.splashDraw),
            ease: EASE_ENTER,
            delay: base + order * seconds(duration.splashStroke),
          },
        };
  const wing = (open: number) => ({
    initial: false as const,
    animate: { scaleX: open },
    style: { originX: 0, originY: 0.5 },
    transition: reduce ? { duration: 0 } : motionSpring(spring.gentle),
  });
  const wings = WINGS_OPEN[step] ?? 1;

  const flying = leaving && flight;
  const markTarget = flying
    ? { x: flight.x, y: flight.y, scale: flight.scale, opacity: 0 }
    : leaving && flight === null
      ? { x: 0, y: 0, scale: 1, opacity: 0 }
      : { x: 0, y: 0, scale: 1, opacity: 1 };
  const markTransition = flying
    ? {
        ...motionSpring(spring.smooth),
        opacity: {
          duration: seconds(duration.short),
          delay: seconds(SPLASH_LEAVE_MS - duration.short),
          ease: EASE_EXIT,
        },
      }
    : { duration: seconds(duration.short), ease: EASE_EXIT };

  return (
    <div
      className="startup-splash"
      data-tone={line.tone}
      data-leaving={leaving || undefined}
      data-testid="startup-splash"
    >
      <div className="startup-splash-veil" />
      <div className="startup-splash-body">
        <m.div
          ref={markRef}
          className="startup-splash-mark"
          animate={markTarget}
          transition={markTransition}
          data-testid="startup-splash-mark"
        >
          <svg
            width={GLYPH}
            height={(GLYPH * 3) / 4}
            viewBox="0 0 64 48"
            aria-hidden="true"
            focusable="false"
          >
            {[false, true].map((mirrored) => (
              <g key={String(mirrored)} transform={mirrored ? "matrix(-1 0 0 1 64 0)" : undefined}>
                <m.path d={ANTENNA} {...STROKE} {...draw(1)} />
                <m.g {...wing(wings)} data-wing={mirrored ? "left" : "right"}>
                  <m.path d={FOREWING} {...STROKE} {...draw(2)} />
                  <m.path d={HINDWING} {...STROKE} {...draw(3)} />
                  <m.path d={VEIN} {...STROKE} strokeWidth={1.25} {...draw(4)} />
                </m.g>
              </g>
            ))}
            <m.path d={BODY} {...STROKE} {...draw(0)} />
          </svg>
        </m.div>
        <div className="startup-splash-copy">
          <m.h1
            className="startup-splash-wordmark"
            {...(reduce
              ? { initial: false as const }
              : {
                  initial: { opacity: 0, clipPath: "inset(-0.2em 100% -0.2em 0)" },
                  animate: { opacity: 1, clipPath: "inset(-0.2em 0% -0.2em 0)" },
                  transition: {
                    duration: seconds(duration.long),
                    ease: EASE_ENTER,
                    delay: base + seconds(duration.splashStroke) * 4,
                  },
                })}
          >
            {/* i18n-ignore: the product name is never translated */}
            Psyche
          </m.h1>
          <p role="status" aria-live="polite" className="startup-splash-status">
            <span key={line.text} className="startup-splash-line">
              {line.text}
            </span>
          </p>
          {line.detail && line.detail.length > 0 ? (
            <ul
              className="flex flex-col items-center gap-0.5 text-callout text-label-secondary"
              data-testid="startup-splash-detail"
            >
              {line.detail.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
          {failed ? null : (
            <ol className="startup-splash-steps" aria-hidden="true" data-step={step}>
              {Array.from({ length: STEPS }, (_, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: three fixed marks
                  key={i}
                  data-state={i < step ? "done" : i === step ? "active" : "todo"}
                />
              ))}
            </ol>
          )}
          {slow && !failed ? <p className="startup-splash-hint">{t("web.splash.slow")}</p> : null}
          {failed ? (
            <div className="startup-splash-fail">
              {line.reason ? <p className="startup-splash-reason">{line.reason}</p> : null}
              <div className="startup-splash-actions flex justify-center gap-2">
                {onShowLogs ? (
                  <Button variant="outline" size="sm" onClick={onShowLogs}>
                    {t("web.splash.showLogs")}
                  </Button>
                ) : null}
                {onRetry ? (
                  <Button size="sm" onClick={onRetry}>
                    {t("common.tryAgain")}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {actions && actions.length > 0 ? (
            <div className="startup-splash-actions flex flex-wrap justify-center gap-2">
              {actions.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant={a.primary ? "default" : "outline"}
                  onClick={a.onClick}
                >
                  {a.text}
                </Button>
              ))}
            </div>
          ) : null}
          {below}
          {onOpenAnyway ? (
            <Button
              variant="link"
              size="sm"
              className="startup-splash-actions startup-splash-anyway text-label-secondary"
              onClick={onOpenAnyway}
            >
              {t("web.splash.openAnyway")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
