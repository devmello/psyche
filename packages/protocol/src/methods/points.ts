import {
  PointsAskParams,
  PointsAskResult,
  PointsStartParams,
  PointsStartResult,
  PointsStatusParams,
  PointsStatusResult,
  PointsStopParams,
  PointsStopResult,
  PointsWindowsParams,
  PointsWindowsResult,
} from "../schemas/points.ts";
import { defineMethod } from "./define.ts";

/**
 * `points.*` Psyche points, you click (docs/design/psyche-points-2026.md §8). Every method is
 * `operator.admin` and, in the handler, refused (`forbidden`) unless the call is the Host's own
 * desktop shell on a loopback connection: never a paired phone, another Mac or a window onto a
 * remote Gateway. The Gateway forwards to the Host helper's `points.*` capabilities
 * (`schemas/points.ts`), which are Host-only, Mac-only and unreachable through `nodes.invoke`.
 *
 * Nothing here can act in another app: there is no click, key, value or point in any shape.
 */
export const PointsMethods = {
  "points.windows": defineMethod({
    params: PointsWindowsParams,
    result: PointsWindowsResult,
    scope: "operator.admin",
    description:
      "Desktop shell only, Host Mac only: the windows the owner can pick for Psyche points (app, title through Accessibility, and why one is refused). No Screen Recording needed.",
  }),
  "points.start": defineMethod({
    params: PointsStartParams,
    result: PointsStartResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting. Desktop shell only, Host Mac only: starts one Points session on the window the owner picked, with an optional goal and the card's fixed strings. The result carries no title or values.",
  }),
  "points.stop": defineMethod({
    params: PointsStopParams,
    result: PointsStopResult,
    scope: "operator.admin",
    description: "Desktop shell only: ends the Points session and removes its overlay.",
  }),
  "points.status": defineMethod({
    params: PointsStatusParams,
    result: PointsStatusResult,
    scope: "operator.admin",
    description:
      "Desktop shell only: the running Points session's app, state, page, step and whether vision mode is on.",
  }),
  "points.ask": defineMethod({
    params: PointsAskParams,
    result: PointsAskResult,
    scope: "operator.admin",
    callsModel: true,
    description:
      "Desktop shell only: the owner's own question about the form (Ask in Psyche…), answered with one model call that has no tools.",
  }),
} as const;
