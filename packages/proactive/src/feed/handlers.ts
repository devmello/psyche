import type { MethodParams, MethodResult } from "@psyche/protocol";
import type { FeedService } from "./service.ts";

type FeedMethod = "feed.list" | "feed.feedback" | "feed.generate";

export type FeedHandlers = {
  [M in FeedMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

const strip = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `feed.*` handlers for the Gateway (params validated and scopes checked by the router). */
export function createFeedHandlers(feed: FeedService): FeedHandlers {
  return {
    "feed.list": (p) => feed.list(strip(p)),
    "feed.feedback": (p) =>
      feed.feedback({
        postId: p.postId,
        feedback: p.feedback ?? null,
        ...(p.topic === undefined ? {} : { topic: p.topic }),
      }),
    "feed.generate": async (p) => {
      const result = await feed.generate(
        p.briefingId === undefined ? {} : { briefingId: p.briefingId },
      );
      return { posts: result.posts.map(({ batchId: _b, ...post }) => post) };
    },
  };
}
