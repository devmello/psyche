import { type Static, Type } from "@sinclair/typebox";
import { Nullable, Provenance } from "../common.ts";

/**
 * Sources behind a grounded answer, a widget or a canvas artifact (citations). A leaf module, so
 * blocks, widgets and surfaces can all import it without a cycle.
 */

/**
 * One source behind a `search_everything` answer (search roadmap §6.3): a chip that opens the
 * item. Title, source and span come from mail, messages and files (untrusted): plain text only.
 */
export const AnswerSource = Type.Object(
  {
    id: Type.String({ maxLength: 200 }),
    /** Producer: `mail`, `messages`, `notes`, `library`, … */
    source: Type.String({ maxLength: 80 }),
    kind: Type.String({ maxLength: 40 }),
    title: Type.String({ maxLength: 200 }),
    date: Type.String({ maxLength: 10 }),
    /** In-app deep link that opens the item; null when it has no pane. */
    route: Nullable(Type.String({ maxLength: 500 })),
    provenance: Provenance,
    /** The cited passage ("show the source"). */
    span: Type.String({ maxLength: 500 }),
  },
  { $id: "AnswerSource" },
);
export type AnswerSource = Static<typeof AnswerSource>;
