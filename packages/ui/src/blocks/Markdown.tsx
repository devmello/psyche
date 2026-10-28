import type { ReactElement } from "react";
import { type Components, Streamdown } from "streamdown";
import { t } from "../i18n/core.ts";
import { useSmoothText } from "../lib/smooth-text.ts";
import { cn } from "../lib/utils.ts";
import { SafeLink } from "../links/SafeLink.tsx";
import { psycheCodePlugin } from "./highlighter.ts";

const STREAM_FADE = {
  animation: "fadeIn",
  duration: 140,
  easing: "ease-out",
  sep: "word",
} as const;

export interface MarkdownProps {
  /** Markdown source. Model output is untrusted: it is sanitized and raw HTML is not rendered. */
  children: string;
  /** True while deltas are still arriving (incomplete syntax is repaired, a caret shows). */
  streaming?: boolean;
  className?: string;
}

/** Only these link schemes render as links; anything else becomes plain text. In-app
 * `psyche:` deep links are not accepted from model text (no link-supplied addresses). */
// A leading "/" is allowed only for same-origin paths: "//host" and "/\\host" are
// protocol-relative and would leave the app (or reach a network share).
const SAFE_LINK = /^(https?:|mailto:|#|\/(?![/\\]))/i;

export function isSafeLink(url: string): boolean {
  return SAFE_LINK.test(url.trim());
}

// Module-level and stable: Streamdown memoizes each finished block on the identity of these props,
// so inline objects or functions would re-render every block on every token.
const PLUGINS = { code: psycheCodePlugin };
const CONTROLS = { code: true, table: false };
const LINK_SAFETY = { enabled: false };
const urlTransform = (url: string): string => (isSafeLink(url) ? url : "");
const COMPONENTS: Components = {
  img: ({ alt }) => (
    <span className="text-muted-foreground">
      {t("blocks.markdown.image", { alt: alt || t("blocks.markdown.untitled") })}
    </span>
  ),
  a: ({ href, children: label }) =>
    href ? (
      <SafeLink href={href} className="text-accent-11 underline underline-offset-2">
        {label}
      </SafeLink>
    ) : (
      <span>{label}</span>
    ),
};

/**
 * Streamed, sanitized Markdown (UI design §3.0, §3.2): Streamdown with rehype sanitization,
 * no raw HTML, safe link schemes only, images not loaded (remote content stays out of the
 * transcript), and Shiki code blocks.
 */
export function Markdown({ children, streaming = false, className }: MarkdownProps): ReactElement {
  // Bursty deltas are released one frame at a time, and the tail drains after the stream ends.
  const text = useSmoothText(children, streaming);
  const live = streaming || text !== children;
  return (
    <Streamdown
      className={cn(
        "psy-markdown psy-prose prose-width text-reading text-label-primary",
        className,
      )}
      mode={live ? "streaming" : "static"}
      parseIncompleteMarkdown={live}
      isAnimating={live}
      caret={live ? "block" : undefined}
      // Opacity only, one short fade per newly arrived chunk (no transforms: they jank).
      animated={live ? STREAM_FADE : false}
      plugins={PLUGINS}
      controls={CONTROLS}
      linkSafety={LINK_SAFETY}
      skipHtml
      urlTransform={urlTransform}
      components={COMPONENTS}
    >
      {text}
    </Streamdown>
  );
}
