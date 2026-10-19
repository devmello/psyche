import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { GatewayClient } from "../client.ts";
import { type CommandSpec, str } from "../command.ts";
import { CliError } from "../errors.ts";
import { kv } from "../output.ts";
import { callIfAvailable } from "./util.ts";

/**
 * "Download your data" (feature U2; security §14): threads, files, memory, receipts, grants, the
 * audit log and `config.json`, with vault *references* only. Gateway data comes through the API;
 * the audit log, config and Library files are copied from `$PSYCHE_HOME` when the CLI runs on the
 * Gateway's machine. Anything unavailable is listed under `skipped` in `export.json`.
 */

interface Skipped {
  what: string;
  reason: string;
}

function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

async function paged<T>(
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
  key: string,
): Promise<{ ok: true; items: T[] } | { ok: false; reason: string }> {
  const items: T[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 10_000; i++) {
    const r = await callIfAvailable<Record<string, unknown>>(client, method, {
      ...params,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (!r.ok) return { ok: false, reason: r.message };
    items.push(...((r.value[key] as T[]) ?? []));
    cursor = r.value.nextCursor as string | null | undefined;
    if (!cursor) break;
  }
  return { ok: true, items };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

export const exportCommands: CommandSpec[] = [
  {
    path: ["export"],
    summary: "Download your data: threads, memory, receipts, grants, Library, audit log, config",
    options: {
      out: {
        type: "string",
        short: "o",
        description: "Output directory (default ./psyche-export-<time>)",
      },
    },
    async run(ctx, { opts }) {
      const stamp = ctx.deps.now().toISOString().replace(/[:.]/g, "-");
      const out = resolve(str(opts, "out") ?? `psyche-export-${stamp}`);
      if (existsSync(out) && readdirSync(out).length > 0)
        throw new CliError("usage", `${out} is not empty`);
      mkdirSync(out, { recursive: true, mode: 0o700 });
      chmodSync(out, 0o700);
      const client = await ctx.gateway();
      const skipped: Skipped[] = [];
      const counts: Record<string, number> = {};

      // Threads: Markdown for reading, JSON for tools.
      const threads = await paged<{ thread: { id: string; title: string } }>(
        client,
        "threads.list",
        { includeArchived: true },
        "threads",
      );
      if (threads.ok) {
        counts.threads = 0;
        for (const { thread } of threads.items) {
          const base = join(
            out,
            "threads",
            `${safeName(thread.id)}-${safeName(thread.title || "untitled")}`,
          );
          for (const format of ["markdown", "json"] as const) {
            const r = await callIfAvailable<{ content: string }>(client, "chat.export", {
              threadId: thread.id,
              format,
            });
            if (r.ok)
              writeFile(`${base}.${format === "markdown" ? "md" : "json"}`, r.value.content);
            else skipped.push({ what: `thread ${thread.id} (${format})`, reason: r.message });
          }
          counts.threads++;
        }
      } else skipped.push({ what: "threads", reason: threads.reason });

      // Memory (workspace files and claims) as the Gateway's zip.
      const memory = await callIfAvailable<{ filename: string; data: string; bytes: number }>(
        client,
        "memory.export",
        {},
      );
      if (memory.ok) {
        writeFile(
          join(out, "memory", basename(memory.value.filename) || "memory.zip"),
          Buffer.from(memory.value.data, "base64"),
        );
        counts.memoryBytes = memory.value.bytes;
      } else skipped.push({ what: "memory", reason: memory.message });

      for (const [what, method, params, key] of [
        ["receipts", "receipts.list", {}, "receipts"],
        ["grants", "grants.list", { includeRevoked: true }, "grants"],
        ["library", "library.list", {}, "items"],
      ] as const) {
        const r =
          what === "grants"
            ? await callIfAvailable<Record<string, unknown[]>>(client, method, params).then((x) =>
                x.ok
                  ? { ok: true as const, items: x.value[key] ?? [] }
                  : { ok: false as const, reason: x.message },
              )
            : await paged<unknown>(client, method, params, key);
        if (r.ok) {
          writeFile(join(out, `${what}.json`), JSON.stringify(r.items, null, 2));
          counts[what] = r.items.length;
          if (what === "library")
            copyLibrary(ctx.home, r.items as { id: string; path: string }[], out, skipped, counts);
        } else skipped.push({ what, reason: r.reason });
      }

      // Vault references only: names, slugs, bindings. Never values.
      const vault = await callIfAvailable<{ credentials: Record<string, unknown>[] }>(
        client,
        "vault.list",
        {},
      );
      if (vault.ok) {
        const refs = vault.value.credentials.map(({ id, kind, name, slug, bindings }) => ({
          id,
          kind,
          name,
          slug,
          bindings,
        }));
        writeFile(join(out, "vault-references.json"), JSON.stringify(refs, null, 2));
        counts.vaultReferences = refs.length;
      } else skipped.push({ what: "vault references", reason: vault.message });

      // Local files: config.json (no secrets by design) and the hash-chained audit log.
      const config = join(ctx.home, "config.json");
      if (existsSync(config)) copyFileSync(config, join(out, "config.json"));
      else skipped.push({ what: "config.json", reason: `not found in ${ctx.home}` });
      const auditDir = join(ctx.home, "audit");
      if (existsSync(auditDir)) {
        mkdirSync(join(out, "audit"), { mode: 0o700 });
        const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
        for (const f of files) copyFileSync(join(auditDir, f), join(out, "audit", f));
        counts.auditFiles = files.length;
      } else
        skipped.push({
          what: "audit log",
          reason: `no ${auditDir} (run export on the Gateway's machine)`,
        });

      const manifest = {
        format: "psyche-export",
        version: 1,
        createdAt: ctx.deps.now().toISOString(),
        counts,
        skipped,
      };
      writeFile(join(out, "export.json"), JSON.stringify(manifest, null, 2));
      return {
        data: { out, ...manifest },
        human: `${kv({ export: out, ...counts })}${skipped.length ? `\nSkipped:\n${skipped.map((s) => `  ${s.what}: ${s.reason}`).join("\n")}` : ""}`,
      };
    },
  },
];

function copyLibrary(
  home: string,
  items: { id: string; path: string }[],
  out: string,
  skipped: Skipped[],
  counts: Record<string, number>,
): void {
  const root = join(home, "library");
  if (!existsSync(root)) {
    if (items.length)
      skipped.push({
        what: "library files",
        reason: `no ${root} (run export on the Gateway's machine)`,
      });
    return;
  }
  const realRoot = realpathSync(root);
  let copied = 0;
  for (const item of items) {
    const candidate = resolve(root, item.path);
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      skipped.push({ what: `library ${item.id}`, reason: "file missing" });
      continue;
    }
    if (!real.startsWith(realRoot + sep)) {
      skipped.push({ what: `library ${item.id}`, reason: "path outside the Library" });
      continue;
    }
    const dest = join(out, "library", real.slice(realRoot.length + 1));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(real, dest);
    chmodSync(dest, 0o600);
    copied++;
  }
  counts.libraryFiles = copied;
}
