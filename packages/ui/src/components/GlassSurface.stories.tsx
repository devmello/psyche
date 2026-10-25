import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowUp, Library, MessageCircle, Mic, Newspaper, Search, SquarePen } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";
import { useI18n } from "../i18n/index.ts";
import { type GlassImpl, resolveGlassImpl } from "../lib/glass.ts";
import { GlassSurface, type GlassSurfaceProps, useGlassEnvironment } from "./glass-surface.tsx";

/**
 * The Liquid Glass spike (docs/design/research/liquid-glass.md): the same sidebar, toolbar group
 * and composer drawn three ways over a scrolling photo and over text. `window.__glassProbe(s)`
 * scrolls the backdrop for `s` seconds and returns frame-time stats (visual/glass-probe.mjs).
 */

type Backdrop = "photo" | "text";

/** A procedural "photo": sky, sun, three mountain ranges, a lake and bokeh, repeated. */
function Photo(): ReactElement {
  const tile = (
    <svg
      viewBox="0 0 400 600"
      preserveAspectRatio="xMidYMid slice"
      className="block h-[600px] w-full"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e3a8a" />
          <stop offset="0.45" stopColor="#f97316" />
          <stop offset="0.6" stopColor="#fde68a" />
        </linearGradient>
        <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0ea5e9" />
          <stop offset="1" stopColor="#0c4a6e" />
        </linearGradient>
      </defs>
      <rect width="400" height="600" fill="url(#sky)" />
      <circle cx="290" cy="250" r="46" fill="#fff7ed" />
      <path
        d="M0 330 L70 230 L130 300 L210 190 L290 290 L340 240 L400 300 V600 H0Z"
        fill="#7c3aed"
      />
      <path d="M0 370 L60 300 L150 360 L240 280 L320 350 L400 320 V600 H0Z" fill="#4c1d95" />
      <path d="M0 410 L90 360 L180 400 L260 350 L400 400 V600 H0Z" fill="#14532d" />
      <rect y="440" width="400" height="160" fill="url(#lake)" />
      {[40, 110, 170, 230, 300, 360].map((x, i) => (
        <circle
          key={x}
          cx={x}
          cy={470 + (i % 3) * 40}
          r={6 + (i % 4) * 4}
          fill="#fef3c7"
          opacity="0.55"
        />
      ))}
      {[30, 90, 150, 210, 270, 330, 390].map((x) => (
        <rect key={x} x={x - 2} y="390" width="4" height="50" fill="#052e16" />
      ))}
    </svg>
  );
  return (
    <div>
      {tile}
      {tile}
      {tile}
      {tile}
      {tile}
    </div>
  );
}

function Text(): ReactElement {
  const { t } = useI18n();
  const colours = ["text-label-primary", "text-accent-11", "text-label-secondary"];
  return (
    <div className="flex flex-col gap-4 bg-canvas px-6 py-20">
      {Array.from({ length: 30 }, (_, i) => (
        <p
          key={i}
          className={`text-[15px] leading-[22px] ${colours[i % 3]} ${i % 5 === 0 ? "font-semibold text-[20px]" : ""}`}
        >
          {t("glass.demo.paragraph")}
        </p>
      ))}
    </div>
  );
}

const pill =
  "inline-flex h-7 items-center rounded-full px-3 text-[13px] font-medium text-label-primary";

/** The chrome of one window: sidebar, toolbar control group and composer, all glass. */
function MiniApp({
  impl,
  backdrop,
  variant = "regular",
  environment,
  className = "h-[560px] w-[300px]",
}: {
  impl: GlassImpl;
  backdrop: Backdrop;
  variant?: GlassSurfaceProps["variant"];
  environment?: GlassSurfaceProps["environment"];
  className?: string;
}): ReactElement {
  const { t } = useI18n();
  const env = { ...useGlassEnvironment(), ...environment };
  const shared = { impl, variant, ...(environment ? { environment } : {}) };
  const nav = [
    { icon: MessageCircle, label: t("glass.demo.chat") },
    { icon: Search, label: t("glass.demo.search") },
    { icon: Newspaper, label: t("glass.demo.feed") },
    { icon: Library, label: t("glass.demo.library") },
  ];
  return (
    <div className={`relative overflow-hidden rounded-[14px] ${className}`} data-glass-window>
      <div className="absolute inset-0 overflow-y-auto" data-glass-backdrop>
        {backdrop === "photo" ? <Photo /> : <Text />}
      </div>

      <GlassSurface
        role="group"
        aria-label={t("glass.demo.sidebar")}
        radius={14}
        className="absolute top-2 bottom-2 left-2 flex w-[104px] flex-col gap-1 p-2 pt-9"
        {...shared}
      >
        {nav.map(({ icon: Icon, label }, i) => (
          <span
            key={label}
            className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-label-primary ${i === 0 ? "bg-[var(--selection)]" : ""}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </span>
        ))}
        <span className="mt-3 px-1.5 text-[11px] text-label-secondary">
          {t("glass.demo.threadMain")}
        </span>
        <span className="px-1.5 text-[11px] text-label-secondary">
          {t("glass.demo.threadDentist")}
        </span>
        <span className="px-1.5 text-[11px] text-label-secondary">
          {t("glass.demo.threadLisbon")}
        </span>
      </GlassSurface>

      <GlassSurface
        role="group"
        aria-label={t("glass.demo.toolbar")}
        radius={16}
        className="absolute top-2 right-2 flex h-8 items-center gap-0.5 px-1"
        {...shared}
      >
        <button type="button" className={pill}>
          {t("glass.demo.mode")}
        </button>
        <button type="button" className={pill}>
          {t("glass.demo.model")}
        </button>
        <button type="button" className={pill} aria-label={t("glass.demo.newChat")}>
          <SquarePen className="size-3.5" aria-hidden="true" />
        </button>
      </GlassSurface>

      <GlassSurface
        role="group"
        aria-label={t("glass.demo.composer")}
        radius={22}
        className="absolute right-2 bottom-2 left-[120px] flex h-11 items-center gap-1 pr-1.5 pl-3"
        {...shared}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-label-secondary">
          {t("glass.demo.composer")}
        </span>
        <button
          type="button"
          aria-label={t("glass.demo.dictate")}
          className="flex size-7 items-center justify-center rounded-full text-label-secondary"
        >
          <Mic className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("glass.demo.send")}
          className="flex size-7 items-center justify-center rounded-full bg-accent-9 text-white"
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </button>
      </GlassSurface>

      <p className="pointer-events-none absolute right-3 bottom-16 left-[124px] rounded-md bg-black/55 px-2 py-1 text-[11px] text-white">
        {t("glass.impl.resolved", {
          requested: t(`glass.impl.${impl}`),
          resolved: t(`glass.impl.${resolveGlassImpl(impl, env)}`),
        })}
      </p>
    </div>
  );
}

function Comparison({ backdrop }: { backdrop: Backdrop }): ReactElement {
  const { t } = useI18n();
  const columns: GlassImpl[] = ["css", "refraction", "native"];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        {columns.map((impl) => (
          <div key={impl} className="flex flex-col gap-1.5">
            <h2 className="text-[13px] font-semibold text-label-primary">
              {t(`glass.impl.${impl}`)} ·{" "}
              {t(`glass.demo.backdrop${backdrop === "photo" ? "Photo" : "Text"}`)}
            </h2>
            <MiniApp impl={impl} backdrop={backdrop} />
          </div>
        ))}
      </div>
      <p className="text-[12px] text-label-secondary">{t("glass.impl.nativeNote")}</p>
    </div>
  );
}

interface ProbeStats {
  impl: string;
  frames: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  dropped: number;
}

declare global {
  interface Window {
    __glassProbe?: (seconds: number) => Promise<ProbeStats>;
  }
}

/** Scrolls the backdrop under the chrome and records requestAnimationFrame deltas. */
function useFrameProbe(impl: string): void {
  const implRef = useRef(impl);
  implRef.current = impl;
  useEffect(() => {
    window.__glassProbe = (seconds) =>
      new Promise((resolve) => {
        const scroller = document.querySelector<HTMLElement>("[data-glass-backdrop]");
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + seconds * 1000;
        let dir = 1;
        const step = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (scroller) {
            scroller.scrollTop += 4 * dir;
            if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) dir = -1;
            if (scroller.scrollTop <= 0) dir = 1;
          }
          if (now < end) requestAnimationFrame(step);
          else {
            const d = deltas.slice(5).sort((a, b) => a - b);
            const q = (p: number) => d[Math.min(d.length - 1, Math.floor(p * d.length))] ?? 0;
            const mean = d.reduce((a, b) => a + b, 0) / Math.max(1, d.length);
            const budget = q(0.5) * 1.5;
            resolve({
              impl: implRef.current,
              frames: d.length,
              mean: Number(mean.toFixed(2)),
              p50: Number(q(0.5).toFixed(2)),
              p95: Number(q(0.95).toFixed(2)),
              p99: Number(q(0.99).toFixed(2)),
              max: Number((d.at(-1) ?? 0).toFixed(2)),
              dropped: d.filter((x) => x > budget).length,
            });
          }
        };
        requestAnimationFrame((now) => {
          last = now;
          requestAnimationFrame(step);
        });
      });
    return () => {
      window.__glassProbe = undefined;
    };
  }, []);
}

function Probe({ impl, backdrop }: { impl: GlassImpl; backdrop: Backdrop }): ReactElement {
  useFrameProbe(impl);
  return <MiniApp impl={impl} backdrop={backdrop} className="h-[700px] w-[940px]" />;
}

const meta = {
  title: "Primitives/GlassSurface",
  component: GlassSurface,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GlassSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ComparisonPhoto: Story = { render: () => <Comparison backdrop="photo" /> };
export const ComparisonText: Story = { render: () => <Comparison backdrop="text" /> };

export const ClearOverPhoto: Story = {
  render: () => (
    <div className="flex gap-3">
      <MiniApp impl="css" variant="clear" backdrop="photo" />
      <MiniApp impl="refraction" variant="clear" backdrop="photo" />
    </div>
  ),
};

/** Reduce Transparency and Increase Contrast land every rung on the opaque material. */
export const ReduceTransparency: Story = {
  render: () => (
    <div className="flex gap-3">
      <MiniApp impl="refraction" backdrop="photo" environment={{ reduceTransparency: true }} />
      <MiniApp impl="css" backdrop="text" environment={{ increaseContrast: true }} />
    </div>
  ),
};

export const ProbeCss: Story = {
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
  render: () => <Probe impl="css" backdrop="photo" />,
};
export const ProbeRefraction: Story = {
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
  render: () => <Probe impl="refraction" backdrop="photo" />,
};
export const ProbeOpaque: Story = {
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
  render: () => <Probe impl="opaque" backdrop="photo" />,
};
export const ProbeTextRefraction: Story = {
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
  render: () => <Probe impl="refraction" backdrop="text" />,
};
