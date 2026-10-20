import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { type ExecResult, PsycheError, type SandboxScope } from "@psyche/protocol";
import { EXEC_OUTPUT_CAP_BYTES, SANDBOX_GID, SANDBOX_UID } from "./limits.ts";
import type { ContainerSandboxRunner } from "./runner.ts";

/**
 * The container smoke test, ported from OpenMuse's (nonroot, read-only system files, disabled
 * network, capped output, text editing, symlink rejection, PDF byte-preserving import/export,
 * stop/start persistence, interruption of a running command) plus PTY and concurrency checks.
 * Shared by `pnpm sandbox:smoke` and the integration tests, so both run the same checks.
 */

export interface SmokeContext {
  runner: ContainerSandboxRunner;
  sandboxId: string;
  scope: SandboxScope;
  /** The runner's `maxConcurrentExecs` (the concurrency check asserts it). */
  maxConcurrentExecs: number;
}

export interface SmokeCheck {
  name: string;
  /** Resolves a short detail line; throws when the check fails. */
  run(ctx: SmokeContext): Promise<string>;
}

async function sh(ctx: SmokeContext, script: string, timeoutMs = 20_000): Promise<ExecResult> {
  return ctx.runner.exec({
    sandboxId: ctx.sandboxId,
    argv: ["/usr/bin/bash", "-c", script],
    cwd: "/workspace",
    timeoutMs,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof PsycheError, `expected a PsycheError ${code}, got ${String(err)}`);
  assert.equal(err.code, code, err.message);
}

/** A small, valid PDF with a binary stream, so byte preservation is meaningful. */
export function samplePdf(): Buffer {
  const binary = randomBytes(2048);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  let size = parts[0]?.length ?? 0;
  const push = (b: Buffer) => {
    parts.push(b);
    size += b.length;
  };
  objects.forEach((body, i) => {
    offsets.push(size);
    push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1"));
  });
  offsets.push(size);
  push(Buffer.from(`4 0 obj\n<< /Length ${binary.length} >>\nstream\n`, "latin1"));
  push(binary);
  push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  const xref = size;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  push(
    Buffer.from(
      `xref\n0 5\n0000000000 65535 f \n${rows}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(parts);
}

export const SMOKE_CHECKS: readonly SmokeCheck[] = [
  {
    name: "runs as UID/GID 1000 with no capabilities",
    async run(ctx) {
      const r = await sh(ctx, "id -u; id -g; grep CapEff /proc/self/status; getent passwd root");
      assert.equal(r.exitCode, 0, r.stderr);
      const [uid, gid, cap, root] = r.stdout.trim().split("\n");
      assert.equal(uid, String(SANDBOX_UID));
      assert.equal(gid, String(SANDBOX_GID));
      assert.match(cap ?? "", /CapEff:\s+0+$/);
      assert.match(root ?? "", /:\/usr\/sbin\/nologin$/, "root must have no login shell");
      return `uid=${uid} gid=${gid}, ${cap?.trim()}, root shell nologin`;
    },
  },
  {
    name: "system files are read-only; /tmp and /workspace are writable",
    async run(ctx) {
      const r = await sh(
        ctx,
        "for p in /usr/psyche-x /etc/psyche-x /psyche-x; do touch $p 2>/dev/null && echo WROTE $p; done; touch /tmp/ok /workspace/.psyche-smoke && echo writable; rm -f /workspace/.psyche-smoke",
      );
      assert.ok(!r.stdout.includes("WROTE"), r.stdout);
      assert.match(r.stdout, /writable/);
      const suid = await sh(ctx, "find / -xdev -perm /6000 -type f 2>/dev/null | wc -l");
      assert.equal(suid.stdout.trim(), "0", "no setuid/setgid binaries");
      return "writes to /usr, /etc and / fail; no setuid binaries";
    },
  },
  {
    name: "network is unreachable",
    async run(ctx) {
      const started = Date.now();
      const r = await sh(
        ctx,
        "curl -sS -m 5 -o /dev/null http://1.1.1.1 2>&1 && echo REACHED; getent hosts example.com >/dev/null && echo DNS; ls /sys/class/net",
      );
      const ms = Date.now() - started;
      assert.ok(!r.stdout.includes("REACHED"), "curl to 1.1.1.1 must fail");
      assert.ok(!r.stdout.includes("DNS"), "DNS must fail");
      assert.ok(ms < 8_000, `network failure should be fast, took ${ms} ms`);
      const ifaces = r.stdout.trim().split("\n").at(-1);
      return `curl to 1.1.1.1 failed in ${ms} ms; interfaces: ${ifaces}`;
    },
  },
  {
    name: "output is capped at 128 KB per stream",
    async run(ctx) {
      const r = await sh(
        ctx,
        "head -c 400000 /dev/zero | tr '\\0' a; head -c 300000 /dev/zero | tr '\\0' b >&2",
      );
      assert.equal(r.exitCode, 0);
      assert.equal(Buffer.byteLength(r.stdout), EXEC_OUTPUT_CAP_BYTES);
      assert.equal(Buffer.byteLength(r.stderr), EXEC_OUTPUT_CAP_BYTES);
      assert.equal(r.truncated, true);
      return `stdout ${r.stdout.length} B, stderr ${r.stderr.length} B, truncated`;
    },
  },
  {
    name: "argv is not a shell string; env arrives intact",
    async run(ctx) {
      const r = await ctx.runner.exec({
        sandboxId: ctx.sandboxId,
        argv: ["printf", "%s|%s", "$HOME; rm -rf /", "$PSYCHE_SMOKE"],
        cwd: "/workspace",
        env: { PSYCHE_SMOKE: "a b;c" },
        timeoutMs: 10_000,
      });
      assert.equal(r.stdout, "$HOME; rm -rf /|$PSYCHE_SMOKE");
      const e = await ctx.runner.exec({
        sandboxId: ctx.sandboxId,
        argv: ["bash", "-c", 'printf %s "$PSYCHE_SMOKE"'],
        cwd: "/workspace",
        env: { PSYCHE_SMOKE: "a b;c" },
        timeoutMs: 10_000,
      });
      assert.equal(e.stdout, "a b;c");
      return "literal argv, env value preserved";
    },
  },
  {
    name: "planted programs on PATH and hostile env names cannot hijack the helpers",
    async run(ctx) {
      // /workspace/.local/bin is first on the image PATH, so the agent can write there.
      const plant = await sh(
        ctx,
        "mkdir -p .local/bin && for p in bash python3 timeout setsid env find head cat rm mkdir touch date; do printf '#!/bin/sh\ncat > /tmp/stolen 2>/dev/null; echo PWNED\n' > .local/bin/$p; chmod +x .local/bin/$p; done",
      );
      assert.equal(plant.exitCode, 0, plant.stderr);
      try {
        const r = await ctx.runner.exec({
          sandboxId: ctx.sandboxId,
          argv: ["/usr/bin/printf", "%s", "ok"],
          cwd: "/workspace",
          env: { PSYCHE_SECRET_SMOKE: "do-not-leak", secs: "86400", __id: "x", PATH: "/nowhere" },
          timeoutMs: 10_000,
        });
        assert.equal(r.stdout, "ok", `wrapper hijacked: ${r.stdout} ${r.stderr}`);
        await ctx.runner.files.writeText(ctx.sandboxId, "smoke/planted.txt", "fine", {
          createParents: true,
        });
        assert.equal(
          (await ctx.runner.files.readText(ctx.sandboxId, "smoke/planted.txt")).text,
          "fine",
        );
        const slow = await ctx.runner.exec({
          sandboxId: ctx.sandboxId,
          argv: ["/usr/bin/sleep", "30"],
          cwd: "/workspace",
          env: { secs: "86400" },
          timeoutMs: 1_000,
        });
        assert.equal(slow.timedOut, true, "an env named secs must not lift the bound");
        const stolen = await sh(ctx, "/usr/bin/cat /tmp/stolen 2>/dev/null; true");
        assert.ok(!stolen.stdout.includes("do-not-leak"), "a planted program read the env");
      } finally {
        await sh(ctx, "/usr/bin/rm -rf /workspace/.local/bin");
      }
      return "exec, file API and timeout unaffected; no env captured";
    },
  },
  {
    name: "timeout kills the command and records uncertain",
    async run(ctx) {
      const r = await ctx.runner.exec({
        sandboxId: ctx.sandboxId,
        argv: ["bash", "-c", "sleep 30 & sleep 31; echo never"],
        cwd: "/workspace",
        timeoutMs: 1_500,
      });
      assert.equal(r.timedOut, true);
      assert.equal(r.outcome, "uncertain");
      assert.equal(r.exitCode, null);
      assert.ok(r.durationMs < 1_500 + 2_000 + 3_000, `took ${r.durationMs} ms`);
      const left = await sh(ctx, "pgrep -fc 'sleep 3[01]' || true");
      assert.equal(left.stdout.trim(), "0", "no sleep processes may survive");
      return `stopped after ${r.durationMs} ms; no processes left`;
    },
  },
  {
    name: "an interrupted command is recorded as uncertain",
    async run(ctx) {
      const ac = new AbortController();
      const pending = ctx.runner.exec({
        sandboxId: ctx.sandboxId,
        argv: ["bash", "-c", "echo started; sleep 300"],
        cwd: "/workspace",
        timeoutMs: 60_000,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 1_500);
      const r = await pending;
      assert.equal(r.outcome, "uncertain");
      assert.equal(r.timedOut, false);
      assert.equal(r.exitCode, null);
      assert.match(r.stdout, /started/);
      const left = await sh(ctx, "pgrep -fc 'sleep 30[0]' || true");
      assert.equal(left.stdout.trim(), "0", "the interrupted process must be gone");
      return `interrupted after ${r.durationMs} ms; process group killed`;
    },
  },
  {
    name: "filesChanged lists created and modified workspace files",
    async run(ctx) {
      const r = await sh(ctx, "mkdir -p smoke && echo 1 > smoke/a.txt && echo 2 > smoke/b.txt");
      assert.deepEqual([...r.filesChanged].sort(), ["smoke/a.txt", "smoke/b.txt"]);
      const again = await sh(ctx, "echo 3 >> smoke/a.txt; cat smoke/b.txt >/dev/null");
      assert.deepEqual(again.filesChanged, ["smoke/a.txt"]);
      return "created and appended files reported; reads are not";
    },
  },
  {
    name: "text write, edit and read are atomic and confined",
    async run(ctx) {
      const { files } = ctx.runner;
      await files.writeText(ctx.sandboxId, "smoke/notes.md", "hello world\n", {
        createParents: true,
        provenance: "trusted",
      });
      const edit = await files.edit(ctx.sandboxId, "/workspace/smoke/notes.md", {
        oldText: "world",
        newText: "sandbox",
      });
      assert.equal(edit.replacements, 1);
      const read = await files.readText(ctx.sandboxId, "smoke/notes.md");
      assert.equal(read.text, "hello sandbox\n");
      // The edit was not marked trusted, so the file is untrusted now (design-07).
      assert.equal(read.provenance, "untrusted");
      await expectCode(
        files.edit(ctx.sandboxId, "smoke/notes.md", { oldText: "absent", newText: "x" }),
        "not_found",
      );
      await expectCode(files.readText(ctx.sandboxId, "../etc/passwd"), "forbidden");
      await expectCode(files.readText(ctx.sandboxId, "/etc/passwd"), "forbidden");
      const listed = await files.list(ctx.sandboxId, "smoke");
      assert.ok(listed.entries.some((e) => e.name === "notes.md" && e.kind === "file"));
      return "write, edit, read ok; .. and absolute paths outside /workspace rejected";
    },
  },
  {
    name: "symlink traversal and special files are rejected",
    async run(ctx) {
      const { files } = ctx.runner;
      const r = await sh(
        ctx,
        "rm -rf smoke/links && mkdir -p smoke/links && ln -s /etc smoke/links/etc && ln -s /etc/passwd smoke/links/pw && mkfifo smoke/links/fifo",
      );
      assert.equal(r.exitCode, 0, r.stderr);
      await expectCode(files.readText(ctx.sandboxId, "smoke/links/pw"), "forbidden");
      await expectCode(files.readText(ctx.sandboxId, "smoke/links/etc/passwd"), "forbidden");
      await expectCode(files.list(ctx.sandboxId, "smoke/links/etc"), "forbidden");
      await expectCode(files.writeText(ctx.sandboxId, "smoke/links/pw", "x"), "forbidden");
      await expectCode(files.exportFile(ctx.sandboxId, "smoke/links/fifo"), "forbidden");
      const listed = await files.list(ctx.sandboxId, "smoke/links");
      assert.equal(listed.entries.find((e) => e.name === "pw")?.kind, "symlink");
      return "symlinked file, symlinked dir and FIFO all rejected";
    },
  },
  {
    name: "PDF import/export preserves bytes",
    async run(ctx) {
      const { files } = ctx.runner;
      const pdf = samplePdf();
      await files.importFile(ctx.sandboxId, "smoke/sample.pdf", pdf, { createParents: true });
      const out = await files.exportFile(ctx.sandboxId, "smoke/sample.pdf");
      assert.ok(Buffer.from(out.bytes).equals(pdf), "exported bytes differ");
      assert.equal(out.provenance, "untrusted", "imports are untrusted at birth");
      const sum = await sh(ctx, "sha256sum smoke/sample.pdf | cut -d' ' -f1");
      const expected = createHash("sha256").update(pdf).digest("hex");
      assert.equal(sum.stdout.trim(), expected);
      await expectCode(
        files.importFile(ctx.sandboxId, "smoke/big.bin", new Uint8Array(10 * 1024 * 1024 + 1)),
        "invalid_params",
      );
      return `${pdf.length} B round trip, sha256 ${expected.slice(0, 12)}…; 10 MB cap holds`;
    },
  },
  {
    name: "files persist across a container restart",
    async run(ctx) {
      const token = randomBytes(8).toString("hex");
      await ctx.runner.files.writeText(ctx.sandboxId, "smoke/persist.txt", token, {
        createParents: true,
      });
      const before = Date.now();
      await ctx.runner.stop(ctx.sandboxId);
      const r = await sh(ctx, "cat smoke/persist.txt");
      assert.equal(r.stdout, token);
      return `stop + restart + exec ${Date.now() - before} ms; workspace kept`;
    },
  },
  {
    name: "PTY mode echoes input",
    async run(ctx) {
      const pty = await ctx.runner.openPty(ctx.sandboxId, { argv: ["bash", "--norc", "-i"] });
      const marker = `pty-${randomBytes(4).toString("hex")}`;
      let seen = "";
      const reader = (async () => {
        for await (const chunk of pty.output) {
          seen += Buffer.from(chunk).toString("utf8");
          if (new RegExp(`${marker}-\\d+-ok`).test(seen)) return true;
        }
        return false;
      })();
      pty.resize(100, 30);
      pty.write(`echo ${marker}-$(tput cols)-ok\n`);
      const ok = await Promise.race([
        reader,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      await pty.close();
      assert.ok(ok, `PTY did not echo; saw: ${JSON.stringify(seen.slice(-300))}`);
      assert.ok(seen.includes(`${marker}-100-ok`), "resize should reach the terminal");
      assert.ok(pty.transcript().includes(marker));
      return "echo and resize (100 cols) through the in-container PTY";
    },
  },
  {
    name: "per-scope concurrency limit holds",
    async run(ctx) {
      const started = Date.now();
      const runs = await Promise.all(
        Array.from({ length: 6 }, () =>
          ctx.runner.exec({
            sandboxId: ctx.sandboxId,
            argv: [
              "bash",
              "-c",
              "mkdir -p /tmp/conc; t=$(mktemp -p /tmp/conc); n=$(ls /tmp/conc | wc -l); sleep 1; rm -f $t; echo $n",
            ],
            cwd: "/workspace",
            timeoutMs: 20_000,
          }),
        ),
      );
      const peak = Math.max(...runs.map((r) => Number(r.stdout.trim())));
      assert.ok(peak <= ctx.maxConcurrentExecs, `peak ${peak} > limit ${ctx.maxConcurrentExecs}`);
      assert.ok(peak >= Math.min(2, ctx.maxConcurrentExecs), `commands did not overlap (${peak})`);
      return `peak ${peak} concurrent, 6 runs in ${Date.now() - started} ms`;
    },
  },
];
