import { NotImplementedError, type SearchIndex } from "@psyche/protocol";

/**
 * Placeholder for the `SearchIndex` implementation owned by S16.
 * Build against `FakeSearchIndex` from `@psyche/testing` until this lands.
 */
export function createSearchIndex(): SearchIndex {
  throw new NotImplementedError("@psyche/search", "createSearchIndex");
}
