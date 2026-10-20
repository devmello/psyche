import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `attention.report`: the desktop tells the Gateway whether the owner is watching, for
 * pause-when-unwatched (docs/05 §7.2 item 5, #272). On sensitive-category apps and origins the
 * agent's actions need the owner's recent input *and* the relevant pane visible; without both
 * they ask (and an unattended Task parks on the card). The desktop calls it when a pane is shown
 * or hidden and, throttled, on the owner's input in the app. Only the desktop shell's own
 * connection may call it; any other device is refused.
 */

export const AttentionPane = StringEnum(["browser", "computer"], { $id: "AttentionPane" });
export type AttentionPane = Static<typeof AttentionPane>;

export const AttentionMethods = {
  "attention.report": defineMethod({
    params: Type.Object({
      pane: AttentionPane,
      visible: Type.Boolean({ description: "The pane is on screen in the desktop app" }),
      input: Type.Optional(
        Type.Boolean({ description: "The owner gave input in the app just now (key, click)" }),
      ),
    }),
    result: Type.Object({ ok: Type.Literal(true) }),
    scope: "operator.write",
    description: "The desktop reports pane visibility and owner input (pause-when-unwatched).",
  }),
} as const;
