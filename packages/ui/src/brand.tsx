import type { CSSProperties, ReactElement } from "react";

/**
 * The Psyche mark and a small status chip, kept from the bootstrap because apps/desktop and
 * apps/web use them before the kit's stylesheet is loaded (inline styles, no Tailwind needed).
 */

export interface PsycheMarkProps {
  /** Pixel size of the glyph. Defaults to 32. */
  size?: number;
  /** Render the "Psyche" word mark next to the glyph. Defaults to true. */
  withWordmark?: boolean;
}

export function PsycheMark({ size = 32, withWordmark = true }: PsycheMarkProps): ReactElement {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: size / 4 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path
          d="M16 6v20M9 11c0 5 3 8 7 8s7-3 7-8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        />
      </svg>
      {withWordmark ? (
        <span style={{ fontSize: size * 0.75, fontWeight: 600, letterSpacing: "-0.01em" }}>
          {/* i18n-ignore: the product name is never translated */}
          Psyche
        </span>
      ) : null}
    </span>
  );
}

export type StatusTone = "ok" | "warn" | "error" | "neutral";

export interface StatusPillProps {
  tone: StatusTone;
  label: string;
  /** Optional accessible description, e.g. "Gateway health". */
  title?: string;
}

const TONE_COLORS: Record<StatusTone, { fg: string; bg: string }> = {
  ok: { fg: "#0f5132", bg: "#d1e7dd" },
  warn: { fg: "#664d03", bg: "#fff3cd" },
  error: { fg: "#842029", bg: "#f8d7da" },
  neutral: { fg: "#41464b", bg: "#e2e3e5" },
};

export function StatusPill({ tone, label, title }: StatusPillProps): ReactElement {
  const { fg, bg } = TONE_COLORS[tone];
  const style: CSSProperties = {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 500,
    color: fg,
    background: bg,
  };
  return (
    <span role="status" title={title} data-tone={tone} style={style}>
      {label}
    </span>
  );
}
