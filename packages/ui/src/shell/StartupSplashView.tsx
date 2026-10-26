import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { motionSpring, spring } from "../motion/tokens.ts";

/**
 * The startup splash's face (#595): the Psyche mark drawing itself in the app's own theme, a
 * lantern glow breathing behind it while Psyche starts (the moth and the lantern from the icon),
 * the wordmark and the status line fading up beneath. On pairing the mark flies into the chat
 * toolbar's avatar (`[data-splash-target]`) and fades as the splash does, so splash and app read
 * as one surface. Reduced motion: no stroke draw, no breathing, no flight; one crossfade.
 *
 * Presentational: apps/web's `StartupSplash` decides the line, when to leave and the actions.
 * Compositor-only after the draw (opacity, transform); no glass.
 */

export interface SplashLineView {
  tone: "progress" | "ready" | "error";
  text: string;
  /** Why the start failed (tone "error"). */
  reason?: string;
}

export interface StartupSplashViewProps {
  line: SplashLineView;
  /** Paired: the splash is giving way to the app. */
  leaving?: boolean;
  onShowLogs?: () => void;
  onRetry?: () => void;
  /** Shown when set: the owner can open the app behind a slow or failed start. */
  onOpenAnyway?: () => void;
}

/** How long the hand-off takes (the caller unmounts after it). */
export const SPLASH_LEAVE_MS = 280;

const GLYPH = 72;
const RING = "M16 2a14 14 0 1 1 0 28a14 14 0 1 1 0-28";
const PSI = "M16 6v20M9 11c0 5 3 8 7 8s7-3 7-8";

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

export function StartupSplashView({
  line,
  leaving = false,
  onShowLogs,
  onRetry,
  onOpenAnyway,
}: StartupSplashViewProps): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  const markRef = useRef<HTMLDivElement>(null);
  const [flight, setFlight] = useState<Flight | null>(null);

  useEffect(() => {
    if (!leaving || reduce || !markRef.current) return;
    setFlight(flightTo(markRef.current.getBoundingClientRect()));
  }, [leaving, reduce]);

  const draw = (delay: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { ...motionSpring(spring.gentle), delay },
        };
  const rise = (delay: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 4 },
          animate: { opacity: 1, y: 0 },
          transition: { ...motionSpring(spring.gentle), delay },
        };

  return (
    <div
      className="startup-splash"
      data-tone={line.tone}
      data-leaving={leaving || undefined}
      data-testid="startup-splash"
    >
      <div className="startup-splash-body">
        <m.div
          ref={markRef}
          className="startup-splash-mark"
          animate={
            flight
              ? { x: flight.x, y: flight.y, scale: flight.scale, opacity: 0 }
              : { x: 0, y: 0, scale: 1, opacity: 1 }
          }
          transition={{
            type: "spring",
            visualDuration: (SPLASH_LEAVE_MS - 30) / 1000,
            bounce: 0,
            opacity: { duration: SPLASH_LEAVE_MS / 1000, ease: "easeIn" },
          }}
          data-testid="startup-splash-mark"
        >
          <span className="startup-splash-lantern" aria-hidden="true" />
          <svg
            width={GLYPH}
            height={GLYPH}
            viewBox="0 0 32 32"
            aria-hidden="true"
            focusable="false"
          >
            <m.path
              d={RING}
              fill="none"
              stroke="var(--accent-9)"
              strokeWidth={2.5}
              strokeLinecap="round"
              {...draw(0.3)}
            />
            <m.path
              d={PSI}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              {...draw(0.5)}
            />
          </svg>
        </m.div>
        <m.h1 className="startup-splash-wordmark" {...rise(0.75)}>
          {/* i18n-ignore: the product name is never translated */}
          Psyche
        </m.h1>
        <m.p role="status" aria-live="polite" className="startup-splash-status" {...rise(0.85)}>
          {line.text}
        </m.p>
        {line.tone === "error" ? (
          <div className="flex flex-col items-center gap-3">
            {line.reason ? (
              <p className="m-0 text-callout text-danger-text [overflow-wrap:anywhere]">
                {line.reason}
              </p>
            ) : null}
            <div className="startup-splash-actions flex justify-center gap-2">
              {onShowLogs ? (
                <Button variant="outline" size="sm" onClick={onShowLogs}>
                  {t("web.splash.showLogs")}
                </Button>
              ) : null}
              {onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  {t("web.splash.retry")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {onOpenAnyway ? (
          <Button
            variant="link"
            size="sm"
            className="startup-splash-actions mt-1 text-label-secondary"
            onClick={onOpenAnyway}
          >
            {t("web.splash.openAnyway")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
