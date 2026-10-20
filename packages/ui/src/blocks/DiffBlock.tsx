import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { Markdown } from "./Markdown.tsx";

/** Lines a diff shows inline; the rest is counted, never silently dropped. */
export const DIFF_BLOCK_LINES = 400;

/**
 * A unified diff (the coding helper's patches and commits, a file write's change) in the kit's
 * code block: the same sanitized Streamdown path and Shiki `diff` grammar as fenced code in a
 * message, with its copy control. The fence is longer than any run of backticks in the diff, so
 * diff text can never close it and render as Markdown.
 */
export function diffMarkdown(diff: string, maxLines = DIFF_BLOCK_LINES): string {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines)
    shown.push(t("blocks.diff.moreLines", { count: lines.length - maxLines }));
  const body = shown.join("\n");
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}diff\n${body}\n${fence}`;
}

export function DiffBlock({
  diff,
  maxLines,
  className,
}: {
  diff: string;
  maxLines?: number;
  className?: string;
}): ReactElement {
  return (
    <div className={className} data-testid="diff-block">
      <Markdown>{diffMarkdown(diff, maxLines)}</Markdown>
    </div>
  );
}
