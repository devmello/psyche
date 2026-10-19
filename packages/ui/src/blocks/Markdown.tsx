import type { ReactElement } from "react";
import { Streamdown } from "streamdown";
import { cn } from "../lib/utils.ts";
import { psycheCodePlugin } from "./highlighter.ts";

export interface MarkdownProps {
  /** Markdown source. Model output is untrusted: it is sanitized and raw HTML is not rendered. */
  children: string;
  /** True while deltas are still arriving (incomplete syntax is repaired, a caret shows). */
  streaming?: boolean;
  className?: string;
}

/** Only these link schemes render as links; anything else becomes plain text. */
const SAFE_LINK = /^(https?:|mailto:|psyche:|\/|#)/i;

/**
 * Streamed, sanitized Markdown (UI design §3.0, §3.2): Streamdown with rehype sanitization,
 * no raw HTML, safe link schemes only, images not loaded (remote content stays out of the
 * transcript), and Shiki code blocks.
 */
export function Markdown({ children, streaming = false, className }: MarkdownProps): ReactElement {
  return (
    <Streamdown
      className={cn("psy-markdown prose-width text-base text-foreground", className)}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      caret={streaming ? "block" : undefined}
      plugins={{ code: psycheCodePlugin }}
      controls={{ code: true, table: false }}
      linkSafety={{ enabled: false }}
      skipHtml
      urlTransform={(url) => (SAFE_LINK.test(url) ? url : "")}
      components={{
        img: ({ alt }) => (
          <span className="text-muted-foreground">[image: {alt || "untitled"}]</span>
        ),
        a: ({ href, children: label }) =>
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent-11 underline underline-offset-2"
            >
              {label}
            </a>
          ) : (
            <span>{label}</span>
          ),
      }}
    >
      {children}
    </Streamdown>
  );
}
