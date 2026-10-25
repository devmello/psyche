import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type GlassEnvironment,
  type GlassImpl,
  lensDisplacementMap,
  resolveGlassImpl,
} from "../lib/glass.ts";
import { cn } from "../lib/utils.ts";

/**
 * A Liquid Glass surface for the chrome layer (docs/design/research/liquid-glass.md): sidebar,
 * toolbar groups, the composer, popovers and the palette. Never for content. Four ways to draw
 * it, picked by `resolveGlassImpl` (native → refraction → css → opaque):
 *
 * - `native`: the desktop shell put an `NSGlassEffectView` under the window
 *   (`PSYCHE_GLASS=native`); the surface stays transparent so it shows through.
 * - `refraction`: Chromium only. `backdrop-filter: url(#lens)` bends the backdrop through a
 *   squircle-rim displacement map, then blurs and saturates it.
 * - `css`: `backdrop-filter: blur() saturate()` over a translucent tint.
 * - `opaque`: Reduce Transparency, Increase Contrast, or nothing else works.
 *
 * Every rung keeps the rim highlight and the tint, so the shape reads the same.
 */

export interface GlassSurfaceProps extends HTMLAttributes<HTMLElement> {
  /** The best implementation this surface wants; it gets that or the next supported rung. */
  impl?: GlassImpl;
  /** `regular` for most chrome; `clear` only over media, with a dimming layer behind labels. */
  variant?: "regular" | "clear";
  /** Corner radius in px; capsules pass half their height. */
  radius?: number;
  /** Rim width for refraction, in px. */
  bezel?: number;
  /** Peak refraction shift in px. */
  strength?: number;
  as?: "div" | "aside" | "header" | "nav" | "form" | "section";
  /** Tests and stories pin the environment instead of reading the document. */
  environment?: Partial<GlassEnvironment>;
}

function readEnvironment(): GlassEnvironment {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return {
      nativeGlass: false,
      backdropUrl: false,
      backdrop: false,
      reduceTransparency: false,
      increaseContrast: false,
    };
  }
  const root = document.documentElement;
  const media = (q: string) =>
    typeof window.matchMedia === "function" && window.matchMedia(q).matches;
  const supports = (p: string, v: string) =>
    typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(p, v);
  const chromium = /Chrom(e|ium)\//.test(navigator.userAgent);
  return {
    nativeGlass: root.dataset.glass === "native",
    // Safari parses url() in backdrop-filter but draws nothing; only Chromium renders it.
    backdropUrl: chromium && supports("backdrop-filter", "url(#x)"),
    backdrop:
      supports("backdrop-filter", "blur(1px)") || supports("-webkit-backdrop-filter", "blur(1px)"),
    reduceTransparency:
      root.dataset.reduceTransparency === "true" ||
      (root.dataset.reduceTransparency !== "false" &&
        media("(prefers-reduced-transparency: reduce)")),
    increaseContrast:
      root.dataset.contrast === "high" ||
      (root.dataset.contrast !== "standard" && media("(prefers-contrast: more)")),
  };
}

/** The document's glass environment, kept current as settings and media queries change. */
export function useGlassEnvironment(): GlassEnvironment {
  const [env, setEnv] = useState(readEnvironment);
  useEffect(() => {
    const update = () => setEnv(readEnvironment());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-glass", "data-reduce-transparency", "data-contrast"],
    });
    const queries =
      typeof window.matchMedia === "function"
        ? ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)"].map((q) =>
            window.matchMedia(q),
          )
        : [];
    for (const q of queries) q.addEventListener("change", update);
    return () => {
      observer.disconnect();
      for (const q of queries) q.removeEventListener("change", update);
    };
  }, []);
  return env;
}

/** A data URL of the lens map, at half resolution (the filter scales it up). */
function lensMapUrl(width: number, height: number, radius: number, bezel: number): string | null {
  if (typeof document === "undefined" || width < 2 || height < 2) return null;
  const s = 0.5;
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const pixels = lensDisplacementMap({ width: w, height: h, radius: radius * s, bezel: bezel * s });
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
  return canvas.toDataURL();
}

const TINT: Record<GlassImpl, Record<"regular" | "clear", string>> = {
  native: { regular: "transparent", clear: "transparent" },
  refraction: {
    regular: "color-mix(in oklch, var(--surface-overlay) 50%, transparent)",
    clear: "color-mix(in oklch, var(--surface-overlay) 8%, transparent)",
  },
  css: {
    regular: "color-mix(in oklch, var(--surface-overlay) 62%, transparent)",
    clear: "color-mix(in oklch, var(--surface-overlay) 20%, transparent)",
  },
  opaque: { regular: "var(--surface-overlay)", clear: "var(--surface-overlay)" },
};

export function GlassSurface({
  impl: requested = "css",
  variant = "regular",
  radius = 16,
  bezel = 14,
  strength = 36,
  as: Tag = "div",
  environment,
  className,
  style,
  children,
  ...rest
}: GlassSurfaceProps): ReactElement {
  const live = useGlassEnvironment();
  const env = { ...live, ...environment };
  const impl = resolveGlassImpl(requested, env);
  const ref = useRef<HTMLElement>(null);
  const filterId = `glass-lens-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mapUrl, setMapUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (impl !== "refraction" || ref.current === null || typeof ResizeObserver === "undefined")
      return;
    const el = ref.current;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) =>
        Math.round(s.width) === Math.round(width) && Math.round(s.height) === Math.round(height)
          ? s
          : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [impl]);

  useEffect(() => {
    if (impl !== "refraction") return;
    setMapUrl(lensMapUrl(size.width, size.height, radius, bezel));
  }, [impl, size.width, size.height, radius, bezel]);

  // Refraction keeps the backdrop sharper than plain CSS (the lens is the point), but regular glass
  // still needs enough blur that text behind it can't compete with labels on it.
  const blur = variant === "clear" ? "blur(2px) saturate(1.4)" : "blur(10px) saturate(1.8)";
  const backdrop =
    impl === "refraction" && mapUrl !== null
      ? `url(#${filterId}) ${blur}`
      : impl === "css" || impl === "refraction"
        ? variant === "clear"
          ? "blur(8px) saturate(1.4)"
          : "blur(20px) saturate(1.6)"
        : "none";

  const surfaceStyle: CSSProperties = {
    borderRadius: radius,
    backgroundColor: TINT[impl][variant],
    backdropFilter: backdrop,
    WebkitBackdropFilter: backdrop,
    boxShadow:
      impl === "opaque"
        ? "0 0 0 1px var(--separator-strong)"
        : "inset 0 0.5px 0 oklch(1 0 0 / 45%), inset 0 -0.5px 0 oklch(1 0 0 / 12%), var(--elevation-2)",
    ...style,
  };

  return (
    <Tag
      ref={ref as never}
      data-glass-impl={impl}
      data-glass-variant={variant}
      className={cn("relative isolate", className)}
      style={surfaceStyle}
      {...rest}
    >
      {impl === "refraction" && mapUrl !== null ? (
        <svg aria-hidden="true" width="0" height="0" className="absolute">
          <filter
            id={filterId}
            x="0"
            y="0"
            width={size.width}
            height={size.height}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={mapUrl}
              x="0"
              y="0"
              width={size.width}
              height={size.height}
              preserveAspectRatio="none"
              result="map"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={strength}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </svg>
      ) : null}
      {impl !== "opaque" ? (
        // Specular rim: a 1 px gradient ring, brighter where the light falls (top-left).
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: radius,
            padding: 1,
            background:
              "linear-gradient(135deg, oklch(1 0 0 / 70%), oklch(1 0 0 / 8%) 35%, oklch(1 0 0 / 0%) 60%, oklch(1 0 0 / 28%))",
            WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
            WebkitMaskComposite: "xor",
            mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
            maskComposite: "exclude",
            opacity: variant === "clear" ? 0.8 : 0.6,
          }}
        />
      ) : null}
      {children}
    </Tag>
  );
}
