import { type Captured, type Fixture, replayFetch } from "./replay.ts";

/**
 * `fetch` that answers every request with a fresh copy of a fixture, so one adapter can be
 * called any number of times (the conformance suite streams several times and embeds once).
 * With several fixtures the one whose `request.pathEndsWith` matches the URL answers (first
 * match wins). Records what was sent, like `replayFetch`.
 */
export function repeatFetch(...fixtures: Fixture[]) {
  const requests: Captured[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const fx = fixtures.find((f) => path.endsWith(f.request.pathEndsWith));
    if (fx === undefined) throw new Error(`repeatFetch: no fixture for ${url}`);
    const once = replayFetch(structuredClone(fx));
    try {
      return await once.fetch(input, init);
    } finally {
      requests.push(...once.requests);
    }
  };
  return { fetch: fetchFn as typeof fetch, requests };
}
