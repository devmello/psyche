import { PsycheError, resolveAppRoute } from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../registry.ts";
import type { TurnToolContext } from "./turn.ts";

/**
 * `app_navigate`: offers the owner a button that opens a Psyche screen or Settings section
 * ("Open it for you"). Read-only UI navigation: it changes nothing, so it needs no approval, and
 * it opens nothing by itself: the button does, when the owner clicks it. Only routes on the
 * app's allowlist (`resolveAppRoute`) are accepted.
 */
export const appNavigateTool = defineTool({
  name: "app_navigate",
  description:
    "Offer the owner a button that opens a screen of this app, for example /settings/daily, /feed, /library/documents, /overview, /agent/approvals or /can-do. Use it after you explain where something is (see the psyche-app-guide skill). It opens nothing until the owner clicks.",
  input: Type.Object(
    {
      route: Type.String({
        minLength: 1,
        maxLength: 80,
        description: "An app route such as /settings/daily or /library/artifacts",
      }),
    },
    { additionalProperties: false },
  ),
  sideEffect: "none",
  describeCall: (p) => ({ summary: `Offer to open ${p.route}` }),
  run: async (p, ctx) => {
    const route = resolveAppRoute(p.route);
    if (route === null) {
      throw new PsycheError("invalid_params", `${p.route} is not a screen of this app`);
    }
    (ctx as TurnToolContext).turn.emitBlock({ type: "app_link", route });
    return {
      output: {
        status: "offered",
        route,
        note: "A button is shown. The app opens only when the owner clicks it; say in one line what it opens.",
      },
      provenance: "trusted",
    };
  },
});
