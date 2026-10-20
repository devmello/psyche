import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The OS probes behind the broker's localhost rule (security §3.10; S23 design-03; S05 asked S08
 * or S01 to supply them). `@psyche/permissions` `createLocalProjectVerifier(probes)` decides; these
 * only observe, and every failure reads as "no" so the rule fails closed:
 *
 * - `resolve(host)`: the addresses the name resolves to, looked up by Psyche, never trusting the
 *   name itself (`127.0.0.1.nip.io`, a `.localhost` name a resolver maps elsewhere);
 * - `listenerPid(port)`: the process listening on that TCP port, from `lsof`;
 * - `spawnedByPsyche(pid)`: whether that process descends (through `ps` parent ids) from a
 *   process Psyche started this session and registered as a dev server's root.
 *
 * The shape matches `LocalProjectProbes` from `@psyche/permissions` structurally, so this package
 * does not import it. The composition passes the result to `createLocalProjectVerifier`.
 */
export interface LoopbackProbes {
  resolve(host: string): Promise<string[]>;
  listenerPid(port: number): Promise<number | undefined>;
  spawnedByPsyche(pid: number): Promise<boolean>;
  psychePorts: readonly number[];
}

/** Runs a fixed binary with an argument array (never a shell string); resolves stdout or rejects. */
export type ProbeRunner = (file: string, args: readonly string[]) => Promise<string>;

export const execProbe: ProbeRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err !== null && stdout === "") reject(err);
      else resolve(String(stdout));
    });
  });

export interface LoopbackProbeOptions {
  /** PIDs Psyche spawned this session as dev-server roots (`DevServerRegistry.spawnedPids`). */
  roots: () => Iterable<number>;
  /**
   * Psyche's own listening ports (Gateway, a fixed OAuth redirect port, real-Chrome CDP),
   * read on every check so later registrations count.
   */
  psychePorts?: () => readonly number[];
  /** The Gateway's own PID (default `process.pid`): never a dev-server root. */
  selfPid?: number;
  run?: ProbeRunner;
  lookup?: (host: string) => Promise<string[]>;
  /** Parent-chain depth limit (default 64). */
  maxDepth?: number;
}

/**
 * TCP ports a process listens on (`lsof -a -p <pid> -iTCP -sTCP:LISTEN`): for the Gateway's
 * own process this finds its port and every in-process OAuth receiver, whatever random port
 * they took. Empty on any failure.
 */
export async function listeningPorts(pid: number, run: ProbeRunner = execProbe): Promise<number[]> {
  try {
    const out = await run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    const ports = new Set<number>();
    for (const line of out.split("\n")) {
      const m = /^n.*:(\d+)$/.exec(line.trim());
      if (m?.[1] !== undefined) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    return [];
  }
}

async function systemLookup(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

export function systemLoopbackProbes(options: LoopbackProbeOptions): LoopbackProbes {
  const run = options.run ?? execProbe;
  const resolveName = options.lookup ?? systemLookup;
  const maxDepth = options.maxDepth ?? 64;

  const parentOf = async (pid: number): Promise<number | undefined> => {
    try {
      const out = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
      const ppid = Number.parseInt(out.trim(), 10);
      return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
    } catch {
      return undefined;
    }
  };

  const selfPid = options.selfPid ?? process.pid;
  return {
    // A getter: the verifier reads it on every check, so ports registered later count.
    get psychePorts() {
      return options.psychePorts?.() ?? [];
    },
    async resolve(host) {
      const bare = host.replace(/^\[|\]$/g, "");
      if (isIP(bare) !== 0) return [bare];
      try {
        return await resolveName(bare);
      } catch {
        return [];
      }
    },
    async listenerPid(port) {
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
      try {
        // -t: PIDs only; -sTCP:LISTEN: the listening socket, not clients connected to it.
        const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        const pids = out
          .split(/\s+/)
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isSafeInteger(n) && n > 0);
        // Several listeners (IPv4 and IPv6 from one server) share a PID; different PIDs on one
        // port are ambiguous, and ambiguity is "no".
        const unique = [...new Set(pids)];
        return unique.length === 1 ? unique[0] : undefined;
      } catch {
        return undefined;
      }
    },
    async spawnedByPsyche(pid) {
      // The Gateway's own listeners (OAuth receivers, the Gateway itself) are never a project.
      if (pid === selfPid) return false;
      const roots = new Set([...options.roots()].filter((r) => r !== selfPid));
      if (roots.size === 0) return false;
      let current: number | undefined = pid;
      for (let depth = 0; current !== undefined && depth < maxDepth; depth++) {
        if (roots.has(current)) return true;
        if (current === 1) return false;
        current = await parentOf(current);
      }
      return false;
    },
  };
}
