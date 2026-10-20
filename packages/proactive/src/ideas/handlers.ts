import type { MethodParams, MethodResult } from "@psyche/protocol";
import type { IdeasService } from "./service.ts";

type IdeaMethod = "ideas.list" | "ideas.accept" | "ideas.dismiss";

export type IdeaHandlers = {
  [M in IdeaMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

const strip = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `ideas.*` handlers for the Gateway (params validated and scopes checked by the router). */
export function createIdeaHandlers(ideas: IdeasService): IdeaHandlers {
  return {
    "ideas.list": (p) => ideas.list(strip(p)),
    "ideas.accept": (p) => ideas.accept(strip(p)),
    "ideas.dismiss": async (p) => ({ idea: await ideas.dismiss(p.ideaId, p.reason) }),
  };
}
