import type { ToolCall } from "@psyche/protocol";
import { Component, type ReactElement, type ReactNode, useState } from "react";
import { useRunStep } from "../data/runs.ts";
import { t } from "../i18n/core.ts";
import { toolViewFor } from "./registry.tsx";
import "./tool-views.tsx";

/**
 * The inline preview of a tool call's result (docs/design/chat-experience-2026.md §4.1, §4.7
 * phase 4): a compact view registered for the tool (`registerToolView`), fed the result the run
 * trace kept for the call (`runs.step`, redacted). Loads only when the owner opens it; a view
 * that throws on an unexpected shape shows nothing but its fallback line.
 */

class ViewBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { bad: boolean }
> {
  override state = { bad: false };
  static getDerivedStateFromError(): { bad: boolean } {
    return { bad: true };
  }
  override render(): ReactNode {
    return this.state.bad ? this.props.fallback : this.props.children;
  }
}

/** The text a tool's output reaches the UI as: parsed JSON when it is JSON, else the string. */
export function parseOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const s = output.trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      return output;
    }
  }
  return output;
}

function Loaded({ call }: { call: ToolCall }): ReactElement | null {
  const View = toolViewFor(call.tool);
  const { detail, loading, error } = useRunStep(call.runId, call.stepId ?? null);
  if (View === undefined) return null;
  if (detail === null)
    return (
      <p className="text-callout text-label-secondary" role="status">
        {error ?? (loading ? t("blocks.toolView.loading") : t("blocks.toolView.none"))}
      </p>
    );
  if (detail.output === undefined)
    return <p className="text-callout text-label-secondary">{t("blocks.toolView.none")}</p>;
  return <View call={call} result={parseOutput(detail.output)} />;
}

/** A disclosure under a tool row; nothing when no view is registered for the tool. */
export function ToolResultPreview({ call }: { call: ToolCall }): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (call.status !== "ok" || call.stepId === undefined || toolViewFor(call.tool) === undefined)
    return null;
  return (
    <details className="ms-6" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-default text-callout text-accent-11">
        {t("blocks.toolView.show")}
      </summary>
      {open ? (
        <div
          className="mt-1 max-h-72 overflow-auto rounded-md bg-fill-quaternary p-2 text-callout text-label-primary"
          data-untrusted={call.provenanceOut === "untrusted" ? "true" : undefined}
        >
          <ViewBoundary
            fallback={<p className="text-label-secondary">{t("blocks.toolView.none")}</p>}
          >
            <Loaded call={call} />
          </ViewBoundary>
        </div>
      ) : null}
    </details>
  );
}
