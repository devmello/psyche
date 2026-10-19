/**
 * Minimal line diff for update review (feature T2: "update with diff review"). Myers-style LCS
 * over lines, rendered as a unified diff with three lines of context. Skills are small text
 * files, so the O(n·m) table is fine; inputs above `maxLines` fall back to a whole-file replace.
 */

type Op = { kind: " " | "-" | "+"; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = dp[i] as Uint32Array;
      row[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max((dp[i + 1] as Uint32Array)[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i += 1;
      j += 1;
    } else if (
      ((dp[i + 1] as Uint32Array)[j] as number) >= ((dp[i] as Uint32Array)[j + 1] as number)
    ) {
      ops.push({ kind: "-", line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] as string });
  while (j < m) ops.push({ kind: "+", line: b[j++] as string });
  return ops;
}

export function unifiedDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
  maxLines = 4_000,
): string {
  if (before === after) return "";
  const a = before === undefined ? [] : before.replace(/\r\n?/g, "\n").split("\n");
  const b = after === undefined ? [] : after.replace(/\r\n?/g, "\n").split("\n");
  const header = `--- ${before === undefined ? "/dev/null" : `a/${path}`}\n+++ ${after === undefined ? "/dev/null" : `b/${path}`}\n`;
  const ops =
    a.length > maxLines || b.length > maxLines
      ? [
          ...a.map((line) => ({ kind: "-" as const, line })),
          ...b.map((line) => ({ kind: "+" as const, line })),
        ]
      : lcsOps(a, b);

  const ctx = 3;
  let out = "";
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  while (k < ops.length) {
    if ((ops[k] as Op).kind === " ") {
      k += 1;
      aLine += 1;
      bLine += 1;
      continue;
    }
    // Hunk start: back up to `ctx` context lines.
    let start = k;
    let back = 0;
    while (start > 0 && back < ctx && (ops[start - 1] as Op).kind === " ") {
      start -= 1;
      back += 1;
    }
    let end = k;
    let trailing = 0;
    while (end < ops.length) {
      const op = ops[end] as Op;
      if (op.kind === " ") {
        trailing += 1;
        if (trailing > ctx * 2) break;
      } else trailing = 0;
      end += 1;
    }
    end -= Math.max(0, trailing - ctx);
    const hunk = ops.slice(start, end);
    const aStart = aLine - back;
    const bStart = bLine - back;
    const aCount = hunk.filter((o) => o.kind !== "+").length;
    const bCount = hunk.filter((o) => o.kind !== "-").length;
    out += `@@ -${aCount === 0 ? aStart - 1 : aStart},${aCount} +${bCount === 0 ? bStart - 1 : bStart},${bCount} @@\n`;
    for (const o of hunk) out += `${o.kind}${o.line}\n`;
    for (const o of ops.slice(k, end)) {
      if (o.kind !== "+") aLine += 1;
      if (o.kind !== "-") bLine += 1;
    }
    k = end;
  }
  return out.length === 0 ? "" : header + out;
}
