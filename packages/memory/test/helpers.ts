import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb } from "@psyche/db";
import type { Clock } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { SqliteMemoryStore, type SqliteMemoryStoreOptions } from "../src/store.ts";
import type { ApprovalCheck } from "../src/support.ts";
import type { Embedder } from "../src/vector.ts";

export const APPROVED = "apr_test_ok";
export const approveOnly: ApprovalCheck = (id) => id === APPROVED;

/** Small stand-in templates (the real ones are tested in templates.test.ts). */
export const FIXTURE_TEMPLATES: Record<string, string> = {
  "SOUL.md": "# Soul\n\n<!-- guidance for the owner -->\nI keep things short.\n",
  "IDENTITY.md":
    '---\nname: "{{name}}"\ncreature: "{{creature}}"\nemoji: "{{emoji}}"\n---\n{{name}} helps {{owner}}.\n',
  "USER.md":
    "# About the owner\n\n- Name:\n\n## Directives (dated; latest wins)\n\n<!-- one per line -->\n\n## People\n",
  "AGENTS.md": "# Operating instructions\n\nAsk before acting.\n",
  "MEMORY.md": "# Memory\n\n## People\n",
  "interests.md": "# Interests\n",
  "BOOTSTRAP.md": "# First run\n\nSay hello.\n",
  "DREAMS.md": "# Dreams\n",
};

export interface TestEnv {
  dir: string;
  workspace: string;
  templates: string;
  db: PsycheDb;
  clock: FakeClock;
  store: SqliteMemoryStore;
  cleanup: () => Promise<void>;
}

export function makeTemplates(root: string, files = FIXTURE_TEMPLATES): string {
  const dir = join(root, "templates");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

export async function makeEnv(
  options: Partial<SqliteMemoryStoreOptions> & { clock?: Clock; init?: boolean } = {},
): Promise<TestEnv> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-memory-")));
  const workspace = join(dir, "workspace");
  const templates = makeTemplates(dir);
  const db = openDb(":memory:");
  const clock = (options.clock as FakeClock | undefined) ?? new FakeClock();
  const store = new SqliteMemoryStore({
    sqlite: db.sqlite,
    workspaceDir: workspace,
    clock,
    timeZone: "UTC",
    templatesDir: templates,
    approvals: approveOnly,
    ...options,
  });
  if (options.init !== false) await store.init();
  return {
    dir,
    workspace,
    templates,
    db,
    clock,
    store,
    cleanup: async () => {
      await store.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Deterministic embedder for tests: one dimension per vocabulary word, so cosine reflects
 * shared words exactly (the fake provider's bag-of-characters vectors are too similar).
 */
export function vocabularyEmbedder(
  vocabulary: string[],
  model = "test/vocab",
): Embedder & {
  calls: number;
} {
  const index = new Map(vocabulary.map((w, i) => [w, i]));
  const e = {
    model,
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const v = new Array<number>(vocabulary.length + 1).fill(0);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const i = index.get(w);
          if (i !== undefined) v[i] = (v[i] ?? 0) + 1;
        }
        if (!v.some((x) => x !== 0)) v[vocabulary.length] = 1;
        return v;
      });
    },
  };
  return e;
}
