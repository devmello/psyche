import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `view.*`: desktop pane control (architecture §5, §11). A client (or the agent, through the
 * Gateway) asks for a pane change; the Gateway forwards it to the desktop shell as a
 * `view.command` event. Only the desktop renders panes; other clients get `unavailable`.
 */

export const ViewPane = StringEnum(
  [
    "chat",
    "browser",
    "terminal",
    "files",
    "editor",
    "diff",
    "plan",
    "tasks",
    "subagents",
    "artifact",
    "vm",
  ],
  { $id: "ViewPane" },
);
export type ViewPane = Static<typeof ViewPane>;

export const ViewPlacement = StringEnum(["main", "side", "split"], { $id: "ViewPlacement" });

export const ViewPaneState = Type.Object(
  {
    paneId: Type.String({ minLength: 1 }),
    pane: ViewPane,
    placement: ViewPlacement,
    threadId: Nullable(Id),
    target: Nullable(Type.String()),
  },
  { $id: "ViewPaneState" },
);
export type ViewPaneState = Static<typeof ViewPaneState>;

export const ViewLayout = Type.Object(
  {
    panes: Type.Array(ViewPaneState),
    focusedPaneId: Nullable(Type.String()),
    updatedAt: IsoDateTime,
  },
  { $id: "ViewLayout" },
);
export type ViewLayout = Static<typeof ViewLayout>;

export const ViewOpenParams = Type.Object(
  {
    pane: ViewPane,
    placement: Type.Optional(ViewPlacement),
    threadId: Type.Optional(Id),
    taskId: Type.Optional(Id),
    artifactId: Type.Optional(Id),
    target: Type.Optional(
      Type.String({
        maxLength: 4096,
        description: "Pane-specific target: tab id, workspace path, artifact id",
      }),
    ),
  },
  { $id: "ViewOpenParams" },
);
export type ViewOpenParams = Static<typeof ViewOpenParams>;

const PaneRef = Type.Object(
  {
    paneId: Type.Optional(Type.String({ minLength: 1 })),
    pane: Type.Optional(ViewPane),
  },
  { $id: "ViewPaneRef", description: "Either paneId or pane (the most recent pane of that kind)" },
);

export const ViewMethods = {
  "view.open": defineMethod({
    params: ViewOpenParams,
    result: Type.Object({ commandId: Type.String() }),
    scope: "operator.write",
    description: "Asks the desktop to open (or reveal) a pane.",
  }),
  "view.close": defineMethod({
    params: PaneRef,
    result: OkResult,
    scope: "operator.write",
    description: "Asks the desktop to close a pane.",
  }),
  "view.focus": defineMethod({
    params: PaneRef,
    result: OkResult,
    scope: "operator.write",
    description: "Asks the desktop to focus a pane.",
  }),
  "view.report": defineMethod({
    params: Type.Object({ layout: ViewLayout }),
    result: OkResult,
    scope: "operator.write",
    description:
      "desktop → Gateway: the desktop's current pane layout, sent after every change; view.layout returns the last report.",
  }),
  "view.layout": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ layout: Nullable(ViewLayout) }),
    scope: "operator.read",
    description:
      "Returns the desktop's last reported pane layout (null when no desktop is connected).",
  }),
} as const;
