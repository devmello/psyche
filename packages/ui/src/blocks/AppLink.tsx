import {
  type APP_LIBRARY_SECTIONS,
  type APP_SETTINGS_SECTIONS,
  resolveAppRoute,
} from "@psyche/protocol";
import { ArrowUpRight } from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import type { MessageId } from "../i18n/messages/index.ts";
import { useSlots } from "../slots.tsx";
import type { BlockOf } from "./types.ts";

const RAIL: Record<string, MessageId> = {
  chat: "shell.rail.chat",
  search: "shell.rail.search",
  feed: "shell.rail.feed",
  ideas: "shell.rail.ideas",
  goals: "shell.rail.goals",
  library: "shell.rail.library",
  overview: "shell.rail.overview",
  inbox: "screens.inbox.title",
  "can-do": "capabilities.title",
  onboarding: "onboarding.rerun.title",
};

const AGENT: Record<string, MessageId> = {
  approvals: "agent.sheet.approvals",
  soul: "agent.sheet.soul",
  activity: "overview.section.activity",
  upcoming: "overview.section.upcoming",
};

/** The button's destination in the active language, or null for a route the app does not know. */
export function appRouteLabel(route: string): string | null {
  const resolved = resolveAppRoute(route);
  if (resolved === null) return null;
  const [, first = "", second] = resolved.split("/");
  if (first === "settings") {
    const id = (second ?? "model") as (typeof APP_SETTINGS_SECTIONS)[number];
    return t("blocks.appLink.settings", {
      section: t(`settings.nav.${id === "computer-use" ? "computerUse" : id}`),
    });
  }
  if (first === "agent") return t(AGENT[second ?? ""] ?? ("agent.sheet.label" as const));
  if (first === "library")
    return t(
      `screens.library.section.${(second ?? "documents") as (typeof APP_LIBRARY_SECTIONS)[number]}`,
    );
  const key = RAIL[first];
  return key === undefined ? null : t(key);
}

/**
 * "Open it for you" (the `app_navigate` tool): a button that moves the app to a screen or
 * Settings section. It navigates only when clicked; the label comes from the route, not from
 * model text.
 */
export function AppLinkBlockView({ block }: { block: BlockOf<"app_link"> }): ReactElement | null {
  const { navigate } = useSlots();
  const route = resolveAppRoute(block.route);
  const where = appRouteLabel(block.route);
  if (route === null || where === null) return null;
  return (
    <button
      type="button"
      data-testid="app-link"
      className="my-1 inline-flex items-center gap-1.5 rounded-md border border-gray-6 px-2.5 py-1 text-sm text-accent-11 hover:bg-gray-3"
      onClick={() => navigate?.(route)}
    >
      {t("blocks.appLink.open", { where })}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </button>
  );
}
