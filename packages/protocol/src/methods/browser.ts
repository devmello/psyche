import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `browser.*`: client-facing metadata about agent browser tabs (architecture §8). These are not
 * the agent's browser tools and not the CDP bridge (`src/bridge.ts`); they let a client list,
 * open, close and snapshot tabs. Navigation is limited to http(s); the Gateway's BrowserDriver
 * applies the task's origin policy.
 */

/** `logged-in` uses the persistent profile; `clean` a logged-out partition (architecture §8). */
export const BrowserProfile = StringEnum(["logged-in", "clean"], { $id: "BrowserProfile" });
export type BrowserProfile = Static<typeof BrowserProfile>;

/** Who drives a tab: the agent, the user (Take control) or nobody (agent paused). */
export const BrowserController = StringEnum(["agent", "user", "paused"], {
  $id: "BrowserController",
});
export type BrowserController = Static<typeof BrowserController>;

export const BrowserTab = Type.Object(
  {
    tabId: Type.String({ minLength: 1 }),
    url: Type.String(),
    title: Type.String(),
    profile: BrowserProfile,
    controller: BrowserController,
    taskId: Nullable(Id),
    driver: StringEnum(["cdp", "playwright"], { $id: "BrowserDriverKind" }),
  },
  { $id: "BrowserTab" },
);
export type BrowserTab = Static<typeof BrowserTab>;

export const BrowserSnapshot = Type.Object(
  {
    tabId: Type.String(),
    url: Type.String(),
    title: Type.String(),
    tree: Type.String({
      description: "Accessibility snapshot text with ref_N ids (untrusted content)",
    }),
    capturedAt: IsoDateTime,
  },
  { $id: "BrowserSnapshot" },
);
export type BrowserSnapshot = Static<typeof BrowserSnapshot>;

const HttpUrl = Type.String({ pattern: "^https?://", maxLength: 8192, $id: "HttpUrl" });

export const BrowserMethods = {
  "browser.tabs": defineMethod({
    params: Type.Object({ taskId: Type.Optional(Id) }),
    result: Type.Object({ tabs: Type.Array(BrowserTab) }),
    scope: "operator.read",
    description: "Lists agent browser tabs.",
  }),
  "browser.open": defineMethod({
    params: Type.Object({
      url: HttpUrl,
      profile: Type.Optional(BrowserProfile),
      background: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ tab: BrowserTab }),
    scope: "operator.write",
    description: "Opens a user tab in the agent browser (http and https only).",
  }),
  "browser.close": defineMethod({
    params: Type.Object({ tabId: Type.String({ minLength: 1 }) }),
    result: OkResult,
    scope: "operator.write",
    description: "Closes a tab.",
  }),
  "browser.snapshot": defineMethod({
    params: Type.Object({ tabId: Type.String({ minLength: 1 }) }),
    result: Type.Object({ snapshot: BrowserSnapshot }),
    scope: "operator.read",
    description: "Returns the accessibility snapshot of a tab. The content is untrusted page data.",
  }),
} as const;
