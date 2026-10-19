/**
 * Regenerates the bundled price table (`src/data/prices.json`) from LiteLLM's
 * `model_prices_and_context_window.json`. Run from the package dir:
 *
 *   node scripts/prices-update.ts                      # fetch from GitHub
 *   node scripts/prices-update.ts --input <file>       # use a local copy
 *   node scripts/prices-update.ts --input <file> --source <url> --out <file>
 *
 * `--source` sets the table's `source` field (default: the fetched URL, or `file:<path>`).
 * The JSON is only parsed and normalized (`src/prices-normalize.ts`); nothing in it is run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { normalizeLiteLLM } from "../src/prices-normalize.ts";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DEFAULT_OUT = resolve(import.meta.dirname, "../src/data/prices.json");
const FETCH_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      out: { type: "string" },
      source: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  let text: string;
  let source: string;
  if (values.input !== undefined) {
    text = await readFile(resolve(values.input), "utf8");
    source = values.source ?? `file:${values.input}`;
  } else {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET ${LITELLM_URL} failed: HTTP ${res.status}`);
    text = await res.text();
    source = values.source ?? LITELLM_URL;
  }

  const table = normalizeLiteLLM(JSON.parse(text) as unknown, {
    source,
    generatedAt: new Date().toISOString(),
  });

  const out = values.out !== undefined ? resolve(values.out) : DEFAULT_OUT;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(table, null, 2)}\n`, "utf8");

  const counts = new Map<string, number>();
  for (const ref of Object.keys(table.models)) {
    const provider = ref.slice(0, ref.indexOf("/"));
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  const perProvider = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, n]) => `${provider} ${n}`)
    .join(", ");
  process.stdout.write(
    `wrote ${Object.keys(table.models).length} models to ${out} (${perProvider})\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
