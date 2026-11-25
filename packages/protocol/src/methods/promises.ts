import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable } from "../common.ts";
import {
  PromiseActAction,
  PromiseListView,
  PromiseSummary,
  PromiseView,
} from "../schemas/promises.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/**
 * `promises.*`: the promise ledger (docs/design/promise-ledger-2026.md §8.2), a view over the
 * `graph_loops` rows. Nothing here sends a message: a nudge is a chat draft the owner sends with
 * the usual card. Remote callers get the scrubbed view (§7.2); `promises.delete` and
 * `promises.mute` are desktop-shell only and answer `owner_only` to anyone else.
 */
export const PromisesMethods = {
  "promises.list": defineMethod({
    params: Type.Object({
      view: PromiseListView,
      entityId: Type.Optional(Id),
      dueBefore: Type.Optional(IsoDateTime),
      ...pageParams,
    }),
    result: Type.Object({
      promises: Type.Array(PromiseView),
      /** Promises this caller may not see; shown as one line on a remote device. */
      hiddenCount: Type.Integer({ minimum: 0 }),
      ...nextCursor,
    }),
    scope: "operator.read",
    description:
      "The ledger, filtered by view (yours, theirs, to confirm, closed). Scrubbed for remote callers. Text is untrusted.",
  }),
  "promises.get": defineMethod({
    params: Type.Object({ id: Id }),
    result: Type.Object({ promise: PromiseView }),
    scope: "operator.read",
    description:
      "One promise. Citations and history come back for the desktop shell only; a hidden promise is `not_found` for a remote caller.",
  }),
  "promises.summary": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ summary: PromiseSummary }),
    scope: "operator.read",
    description:
      "Counts, the next due date and the warnings due in the next 7 days (quiet hours applied), for Home and for iOS local notifications. Scrubbed for remote callers.",
  }),
  "promises.act": defineMethod({
    params: Type.Object({ id: Id, action: PromiseActAction }),
    result: Type.Object({ promise: PromiseView }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Confirms, completes, reopens, releases, dismisses, snoozes or re-dates a promise, or answers a question about it. Sends nothing. Side-effecting.",
  }),
  "promises.add": defineMethod({
    params: Type.Object({
      direction: Type.Union([Type.Literal("i_owe"), Type.Literal("waiting_on")]),
      what: Type.String({ minLength: 1, maxLength: 120 }),
      counterpartId: Type.Optional(Id),
      dueAt: Type.Optional(Nullable(IsoDateTime)),
    }),
    result: Type.Object({ promise: PromiseView }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Adds a promise by hand, with the owner's provenance. Side-effecting.",
  }),
  "promises.delete": defineMethod({
    params: Type.Object({ id: Id }),
    result: Type.Object({ ok: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Hard-deletes a promise, its citations and its history, and records that it is not a promise so it is not found again. Desktop shell only. Side-effecting.",
  }),
  "promises.mute": defineMethod({
    params: Type.Object({
      /** One person; or `threadRef`, one thread. Exactly one of the two. */
      entityId: Type.Optional(Id),
      threadRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      muted: Type.Boolean(),
    }),
    result: Type.Object({ ok: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Stops (or resumes) tracking promises with one person or in one thread. Desktop shell only. Side-effecting.",
  }),
};
