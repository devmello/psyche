import { type ChecklistItem, ChecklistItemStatus, PsycheError } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";

/** `update_plan` input (feature C5; Claude desktop notes Q5). Indices are 1-based. */
export const UpdatePlanInput = Type.Object(
  {
    items: Type.Optional(
      Type.Array(
        Type.Object({ text: Type.String({ minLength: 1, maxLength: 200 }), status: ChecklistItemStatus }),
        { minItems: 1, maxItems: 20, description: "The whole list, replacing the current one" },
      ),
    ),
    advance: Type.Optional(
      Type.Boolean({ description: "Complete the in-progress item and start the next pending one" }),
    ),
    done: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), { description: "1-based items to mark completed" }),
    ),
    start: Type.Optional(Type.Integer({ minimum: 1, description: "1-based item to start" })),
  },
  { additionalProperties: false },
);
export type UpdatePlanInput = Static<typeof UpdatePlanInput>;

function invalid(message: string): never {
  throw new PsycheError("invalid_params", message);
}

/**
 * Apply an `update_plan` call: the whole list, `advance`, or out-of-order `done` / `start`.
 * Invariant afterwards: exactly one item is `in_progress` while any item is unfinished, none
 * when everything is completed. A list with unfinished items and none in progress starts the
 * first pending one; two in progress is an error the model sees.
 */
export function applyPlanUpdate(
  current: readonly ChecklistItem[],
  update: UpdatePlanInput,
): ChecklistItem[] {
  const hasOp =
    update.items !== undefined ||
    update.advance === true ||
    (update.done?.length ?? 0) > 0 ||
    update.start !== undefined;
  if (!hasOp) invalid("update_plan needs items, advance, done or start");
  const items: ChecklistItem[] = (update.items ?? current).map((i) => ({ ...i }));
  if (items.length === 0) invalid("there is no checklist yet: send items first");
  const at = (n: number): ChecklistItem => {
    const item = items[n - 1];
    if (item === undefined) invalid(`item ${n} does not exist (the list has ${items.length})`);
    return item;
  };

  for (const n of update.done ?? []) at(n).status = "completed";
  if (update.advance === true) {
    const idx = items.findIndex((i) => i.status === "in_progress");
    if (idx >= 0) {
      (items[idx] as ChecklistItem).status = "completed";
    }
    const next = items.findIndex((i, j) => j > idx && i.status === "pending");
    const fallback = items.findIndex((i) => i.status === "pending");
    const pick = next >= 0 ? next : fallback;
    if (pick >= 0) (items[pick] as ChecklistItem).status = "in_progress";
  }
  if (update.start !== undefined) {
    const item = at(update.start);
    if (item.status === "completed") invalid(`item ${update.start} is already completed`);
    item.status = "in_progress";
  }

  const inProgress = items.filter((i) => i.status === "in_progress").length;
  if (inProgress > 1) {
    invalid("exactly one item may be in_progress; complete the current one first (done or advance)");
  }
  if (inProgress === 0) {
    const firstPending = items.find((i) => i.status === "pending");
    if (firstPending !== undefined) firstPending.status = "in_progress";
  }
  return items;
}
