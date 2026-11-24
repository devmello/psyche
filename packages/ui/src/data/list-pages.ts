/**
 * Reads every page of a cursor-paged Gateway list (`nextCursor`, one request per page). Stops when
 * the Gateway gives no cursor or repeats one, so a misbehaving page cannot loop forever.
 */
export async function collectAllPages<T>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{ items: readonly T[]; nextCursor?: string | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let more = true;
  while (more) {
    const page = await fetchPage(cursor);
    out.push(...page.items);
    const next = page.nextCursor ?? undefined;
    more = next !== undefined && next !== "" && !seen.has(next);
    if (next !== undefined) seen.add(next);
    cursor = more ? next : undefined;
  }
  return out;
}
