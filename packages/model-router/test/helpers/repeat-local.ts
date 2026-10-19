import { type Captured, type Fixture, replayFetch } from "./replay.ts";

/**
 * `fetch` that answers every request with a fresh copy of the fixture whose
 * `request.pathEndsWith` matches the URL (first match wins), so one adapter can be called
 * any number of times (conformance suites). Records what was sent, like `replayFetch`.
 */
export function repeatFetchLocal(...fixtures: Fixture[]) {
  const requests: Captured[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const fx = fixtures.find((f) => path.endsWith(f.request.pathEndsWith));
    if (fx === undefined) throw new Error(`repeatFetchLocal: no fixture for ${url}`);
    const once = replayFetch(structuredClone(fx));
    try {
      return await once.fetch(input, init);
    } finally {
      requests.push(...once.requests);
    }
  };
  return { fetch: fetchFn as typeof fetch, requests };
}
