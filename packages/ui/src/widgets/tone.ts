import type { WidgetTone } from "@psyche/protocol";
import { CircleAlert, CircleCheck, Info, OctagonX } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Semantic tone → tokens (generative-ui-2026 §4.2). Tones pair with an icon and a spoken word so
 * colour is never the only signal. Amber is host-owned ("needs you", approvals), so a widget's
 * `warning` is drawn in the primary label colour with its own icon and never in the approval accent.
 */
export const TONE_TEXT: Record<WidgetTone, string> = {
  neutral: "text-label-secondary",
  info: "text-info-text",
  success: "text-success-text",
  warning: "text-label-primary",
  danger: "text-danger-text",
};

export const TONE_ICON: Record<
  Exclude<WidgetTone, "neutral">,
  ComponentType<{ className?: string }>
> = {
  info: Info,
  success: CircleCheck,
  warning: CircleAlert,
  danger: OctagonX,
};
