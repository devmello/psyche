import type { Call, HandlerDef } from "../context.ts";
import type { EventFilter } from "../event-bus.ts";
import { chatHandlers } from "./chat.ts";
import { devicesHandlers } from "./devices.ts";
import { nodesHandlers } from "./nodes.ts";
import { settingsHandlers } from "./settings.ts";
import { threadsHandlers } from "./threads.ts";

const eventsHandlers: Record<string, HandlerDef> = {
  "events.subscribe": {
    run(call: Call, params: { filters?: EventFilter }) {
      const f = params.filters;
      call.conn.setEventFilter(
        f === undefined || (f.events === undefined && f.threadIds === undefined) ? null : f,
      );
      return { stateVersion: call.ctx.bus.stateVersion };
    },
  },
};

/** Methods S01 implements; every other registered method answers `not_implemented`. */
export const HANDLERS: Readonly<Record<string, HandlerDef>> = {
  ...settingsHandlers,
  ...devicesHandlers,
  ...threadsHandlers,
  ...chatHandlers,
  ...nodesHandlers,
  ...eventsHandlers,
};
