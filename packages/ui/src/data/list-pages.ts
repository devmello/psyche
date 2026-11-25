/**
 * Reads the pages of a cursor-paged Gateway list (`nextCursor`, one request per page). Stops when
 * the Gateway gives no cursor, repeats one, or `maxPages` pages were read (a cap for pickers).
 */
export async function collectAllPages<T>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{ items: readonly T[]; nextCursor?: string | null }>,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let more = true;
  while (more) {
    const page = await fetchPage(cursor);
    pages += 1;
    out.push(...page.items);
    const next = page.nextCursor ?? undefined;
    more = next !== undefined && next !== "" && !seen.has(next) && pages < maxPages;
    if (next !== undefined) seen.add(next);
    cursor = more ? next : undefined;
  }
  return out;
}
