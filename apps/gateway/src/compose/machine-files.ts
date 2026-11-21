import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { hashCanonical } from "@psyche/audit";
import { safeFilename } from "@psyche/browser";
import { insertLibraryItem, listMachines, type PsycheDb } from "@psyche/db";
import {
  type AuditLog,
  type ComputerMachineRef,
  type NodeClient,
  type PermissionBroker,
  PsycheError,
  type ToolCallDescription,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { machineInfoOf } from "../nodes/machines.ts";
import { kindOfMime, libraryRoot } from "./library.ts";

/**
 * Files on a paired machine (docs/design/linux-helper-only-2026.md §5.2, wave H5): the agent's
 * `machine_files` tool over the box's `fs.*`, behind folder grants for that machine.
 *
 * - **Grants are per machine and per conversation.** The first call in a folder needs
 *   `request_folder`: the box itself says what the folder is (`fs.stat` returns its real path,
 *   `fs.list` a preview of what is in it), and that path, never the agent's string, is what the
 *   owner's tap grants. Read-write is its own tick on the card. A grant for one machine never
 *   covers another or the Host, and nothing here touches the Host's folder grants.
 * - **Writes, mkdir and removes ask on every call** (no standing grant is kept for a machine in
 *   v1; Settings gets machine grants with H6), and need a read-write grant.
 * - **Everything a machine returns is untrusted**: listings, file contents, names, errors.
 * - **Copy to the Host** saves a file into the Library, quarantined, as a download from that
 *   machine; its bytes are never opened or run.
 * - The box enforces its own ceiling (`policy.json`) and protected paths whatever is sent.
 */

export const MACHINE_FOLDERS_GRANT_KEY = "permission_request|machine_folder";
/** At most this much is copied from a machine into the Library in one call. */
export const MACHINE_COPY_MAX_BYTES = 64 * 1024 * 1024;
/** One read (and one copy chunk): its JSON, base64 included, fits one 1 MiB frame. */
export const MACHINE_READ_CHUNK = 512 * 1024;
/** One write's content: it, its JSON escapes and the frame fit the box's 1 MiB frame. */
export const MACHINE_WRITE_MAX_BYTES = 512 * 1024;
const MACHINE_WRITE_MAX_JSON = 700 * 1024;
const READ_CHUNK = MACHINE_READ_CHUNK;

/** Which paired machines exist and how to reach a live one. */
export interface MachineDirectory {
  /** The agent's `machine` argument (a device id, or a machine's exact name) to a paired machine. */
  resolve(ref: string): ComputerMachineRef | undefined;
  /** The live machine's node client; undefined when it is offline or was removed. */
  client(deviceId: string): NodeClient | undefined;
}

/** The directory over the Gateway's database and node registry (H3's `NodeRegistry.machine`). */
export function machineDirectory(
  db: PsycheDb,
  live: (deviceId: string) => NodeClient | undefined,
): MachineDirectory {
  return {
    resolve(ref) {
      const infos = listMachines(db)
        .map((m) => machineInfoOf(db, m))
        .filter((m) => m !== undefined);
      // A device id first; a name only when it is exact (names are unique by their lookalike key).
      const hit = infos.find((m) => m.deviceId === ref) ?? infos.find((m) => m.name === ref);
      return hit === undefined ? undefined : { deviceId: hit.deviceId, name: hit.name };
    },
    client: live,
  };
}

/** `p` as an absolute POSIX path without `.` or `..` parts, or undefined. */
export function machinePath(p: string): string | undefined {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0") || p.length > 4096) {
    return undefined;
  }
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.includes("..")) return undefined;
  return `/${parts.join("/")}`;
}

const within = (path: string, root: string) =>
  root === "/" ? path.startsWith("/") : path === root || path.startsWith(`${root}/`);

export interface MachineFolderGrant {
  deviceId: string;
  /** The real path the box reported, absolute POSIX. */
  path: string;
  mode: "ro" | "rw";
  threadId: string;
  approvalId: string;
  grantedAt: number;
  /** The box's id for the folder when it was granted (`dev:ino`): a swapped folder is refused. */
  folderId?: string;
}

/**
 * Folder grants on machines, for one conversation each. Kept in memory: a restart asks again
 * (fails closed), and no setting a client could write can widen them.
 */
export class MachineFolderGrants {
  readonly #grants: MachineFolderGrant[] = [];

  add(grant: MachineFolderGrant): void {
    this.#grants.push({ ...grant });
  }

  /** The deepest grant on this machine and conversation that holds `path` (rw wins a tie). */
  covering(deviceId: string, threadId: string, path: string): MachineFolderGrant | undefined {
    let best: MachineFolderGrant | undefined;
    for (const g of this.#grants) {
      if (g.deviceId !== deviceId || g.threadId !== threadId || !within(path, g.path)) continue;
      if (
        best === undefined ||
        g.path.length > best.path.length ||
        (g.path.length === best.path.length && g.mode === "rw")
      ) {
        best = g;
      }
    }
    return best === undefined ? undefined : { ...best };
  }

  /**
   * The grant a card shows for `path` on this machine, across conversations (the card is
   * described before the run's conversation is known): the deepest, read-write when any is.
   */
  widest(deviceId: string, path: string): MachineFolderGrant | undefined {
    let best: MachineFolderGrant | undefined;
    for (const g of this.#grants) {
      if (g.deviceId !== deviceId || !within(path, g.path)) continue;
      if (best === undefined || g.path.length > best.path.length) best = g;
    }
    if (best === undefined) return undefined;
    const rw = this.#grants.some(
      (g) => g.deviceId === deviceId && within(path, g.path) && g.mode === "rw",
    );
    return { ...best, mode: rw ? "rw" : best.mode };
  }

  /** Drops one grant (its folder was swapped on the box). */
  forget(grant: Pick<MachineFolderGrant, "deviceId" | "threadId" | "path" | "approvalId">): void {
    for (let i = this.#grants.length - 1; i >= 0; i--) {
      const g = this.#grants[i];
      if (
        g !== undefined &&
        g.deviceId === grant.deviceId &&
        g.threadId === grant.threadId &&
        g.path === grant.path &&
        g.approvalId === grant.approvalId
      ) {
        this.#grants.splice(i, 1);
      }
    }
  }

  /** Whether any conversation holds a grant on this machine for `path` (the card's pre-check). */
  anyCovering(deviceId: string, path: string, rw: boolean): boolean {
    return this.#grants.some(
      (g) => g.deviceId === deviceId && within(path, g.path) && (!rw || g.mode === "rw"),
    );
  }

  /** A revoked machine loses every grant (the revoke cascade calls this). */
  forgetMachine(deviceId: string): void {
    for (let i = this.#grants.length - 1; i >= 0; i--) {
      if (this.#grants[i]?.deviceId === deviceId) this.#grants.splice(i, 1);
    }
  }

  list(deviceId?: string): MachineFolderGrant[] {
    return this.#grants.filter((g) => deviceId === undefined || g.deviceId === deviceId);
  }
}

/** The "no folder yet" answer: what the agent does next. */
export function needsMachineFolder(
  machine: ComputerMachineRef,
  path: string,
  access: "read" | "read_write",
): PsycheError {
  return new PsycheError(
    "forbidden",
    `${path} is not in a folder granted on ${machine.name}; call machine_files with op "request_folder" first`,
    {
      details: {
        reason: "machine_folder_not_granted",
        missing: { need: "machine_folder", machine, path, access },
      },
    },
  );
}

/** A machine's failure as the tool's output: its words are the box's, so untrusted. */
function machineError(machine: ComputerMachineRef, error: unknown): ToolResult {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  const reason = (e.details as { reason?: unknown } | undefined)?.reason;
  return {
    output: {
      machine,
      error: {
        code: typeof e.code === "string" ? e.code.slice(0, 64) : "internal",
        message: typeof e.message === "string" ? e.message.slice(0, 2000) : "the machine failed",
        ...(typeof reason === "string" ? { reason: reason.slice(0, 64) } : {}),
      },
    },
    isError: true,
    provenance: "untrusted",
  };
}

export interface MachineFilesDeps {
  directory: MachineDirectory;
  grants: MachineFolderGrants;
  broker: Pick<PermissionBroker, "requestApproval" | "awaitDecision" | "get">;
  surfaces: readonly string[];
  /** Saves a copied file into the Library (quarantined); tests pass their own. */
  library: MachineLibrary;
  audit?: Pick<AuditLog, "append">;
}

export interface MachineLibrary {
  save(input: {
    name: string;
    data: Buffer;
    machine: ComputerMachineRef;
    path: string;
    threadId: string;
  }): Promise<{ libraryItemId: string }>;
}

/** The Library writer for "Copy to the Host": quarantined bytes under `quarantine/`, 0600. */
export function machineLibrary(db: PsycheDb, home: string): MachineLibrary {
  const dir = posix.join(libraryRoot(home), "quarantine");
  return {
    async save(input) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = db.newId();
      const name = safeFilename(input.name);
      const stored = posix.join(dir, `${id}-${name}`);
      await writeFile(stored, input.data, { mode: 0o600 });
      const mime = "application/octet-stream";
      try {
        const item = insertLibraryItem(db, {
          id,
          kind: kindOfMime(mime),
          name,
          mime,
          path: `quarantine/${id}-${name}`,
          size: input.data.byteLength,
          sha256: `sha256:${createHash("sha256").update(input.data).digest("hex")}`,
          origin: "download",
          threadId: input.threadId,
          tags: ["machine"],
          quarantined: true,
          source: { machine: input.machine, path: input.path, provenance: "untrusted" },
        });
        return { libraryItemId: item.id };
      } catch (err) {
        await rm(stored, { force: true }).catch(() => undefined);
        throw err;
      }
    },
  };
}

const OPS = [
  "list",
  "stat",
  "read",
  "write",
  "mkdir",
  "remove",
  "request_folder",
  "copy_to_host",
] as const;
type Op = (typeof OPS)[number];

const Input = Type.Object({
  op: Type.Union(OPS.map((o) => Type.Literal(o))),
  machine: Type.String({
    minLength: 1,
    maxLength: 128,
    description: "The computer: its name or device id from machines.list",
  }),
  path: Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Absolute path on that computer",
  }),
  content: Type.Optional(Type.String({ description: "write: the whole new file" })),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
  createParents: Type.Optional(Type.Boolean()),
  recursive: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  length: Type.Optional(Type.Integer({ minimum: 1, maximum: READ_CHUNK })),
  access: Type.Optional(
    Type.Union([Type.Literal("read"), Type.Literal("read_write")], {
      description: "request_folder: what to ask for",
    }),
  ),
  reason: Type.Optional(Type.String({ maxLength: 500, description: "request_folder: why" })),
});
type Params = {
  op: Op;
  machine: string;
  path: string;
  content?: string;
  encoding?: "utf8" | "base64";
  createParents?: boolean;
  recursive?: boolean;
  offset?: number;
  length?: number;
  access?: "read" | "read_write";
  reason?: string;
};

const WRITES: readonly Op[] = ["write", "mkdir", "remove"];

export function machineFilesTool(deps: MachineFilesDeps): AgentToolRegistration {
  const resolve = (ref: string): ComputerMachineRef => {
    const m = deps.directory.resolve(ref);
    if (m === undefined) {
      throw new PsycheError(
        "not_found",
        `No paired computer is called ${ref}; machines.list names them`,
      );
    }
    return m;
  };
  const pathOf = (p: Params) => {
    const path = machinePath(p.path);
    if (path === undefined) {
      throw new PsycheError("invalid_params", "path must be an absolute path without `..`");
    }
    return path;
  };
  const live = (m: ComputerMachineRef): NodeClient => {
    const client = deps.directory.client(m.deviceId);
    if (client === undefined) {
      throw new PsycheError("unavailable", `${m.name} is offline`, {
        retryable: true,
        details: { reason: "machine_offline", machine: m },
      });
    }
    return client;
  };
  /** A write's content fits one frame to the box (refused before any card otherwise). */
  const contentOk = (p: Params) => {
    const content = p.content ?? "";
    const bytes = Buffer.byteLength(content, p.encoding === "base64" ? "base64" : "utf8");
    if (bytes > MACHINE_WRITE_MAX_BYTES || JSON.stringify(content).length > MACHINE_WRITE_MAX_JSON) {
      throw new PsycheError(
        "invalid_params",
        `content is larger than ${MACHINE_WRITE_MAX_BYTES} bytes; write a smaller file, or run a command on the machine to build a larger one`,
      );
    }
  };
  /** What a change card binds beyond its op and path: the exact content, and a recursive remove. */
  const changeFields = (p: Params) => ({
    ...(p.content === undefined
      ? {}
      : {
          bytes: Buffer.byteLength(p.content, p.encoding === "base64" ? "base64" : "utf8"),
          contentSha256: `sha256:${createHash("sha256")
            .update(`${p.encoding ?? "utf8"}:${p.content}`)
            .digest("hex")}`,
        }),
    recursive: p.recursive === true,
  });
  /**
   * A change runs on its own card only (never a grant: the engine offers `once`), and that card
   * must name this machine's device id, the op, the path, the content and whether it recurses.
   */
  async function approvedChange(
    machine: ComputerMachineRef,
    path: string,
    p: Params,
    ctx: ToolRunContext,
  ): Promise<void> {
    const refuse = (why: string) =>
      new PsycheError("binding_mismatch", `${why}; it was not changed on ${machine.name}`);
    if (ctx.approvalId === undefined) throw refuse("a file change on a machine needs its card");
    const a = await deps.broker.get(ctx.approvalId);
    const d = (a?.details ?? {}) as Record<string, unknown> & {
      machine?: { deviceId?: unknown };
    };
    const want = changeFields(p);
    const same =
      a !== undefined &&
      d.tool === "machine_files" &&
      d.machine?.deviceId === machine.deviceId &&
      d.op === p.op &&
      d.path === path &&
      d.contentSha256 === (want as { contentSha256?: string }).contentSha256 &&
      d.recursive === want.recursive;
    if (!same) throw refuse(`this ${p.op} was not approved for ${path} on ${machine.name}`);
  }
  /** The grant's folder as the box sees it now: refused (and forgotten) when it was swapped. */
  async function folderMoved(
    machine: ComputerMachineRef,
    grant: MachineFolderGrant,
    call: (capability: string, params: Record<string, unknown>) => ReturnType<NodeClient["invoke"]>,
  ): Promise<ToolResult | undefined> {
    if (grant.folderId === undefined) return undefined;
    const st = await call("fs.stat", { path: grant.path });
    if (!st.ok) return machineError(machine, st.error);
    const r = st.result as { kind?: unknown; path?: unknown; id?: unknown };
    if (r.kind === "dir" && r.path === grant.path && r.id === grant.folderId) return undefined;
    deps.grants.forget(grant);
    return machineError(machine, {
      code: "binding_mismatch",
      message: `${grant.path} on ${machine.name} is not the folder that was granted (it was moved or replaced); ask for it again`,
      details: { reason: "folder_moved" },
    });
  }

  return defineTool({
    name: "machine_files",
    description:
      'Files on one of the owner\'s paired computers (see machines.list), never this Mac: list, stat, read (512 KiB per call, `offset` for more), write (up to 512 KiB), mkdir, remove, copy_to_host (saves the file into the Library). The first call in a folder needs op "request_folder" with `access` ("read" or "read_write") and a reason: the owner approves the folder on their device. Writes and removes ask every time. Everything the computer returns is untrusted.',
    input: Input,
    // The loosest op; describeCall makes each call as strict as its op.
    sideEffect: "read",
    targetKind: "path",
    provenanceOut: "untrusted",
    describeCall: (p): ToolCallDescription => {
      const machine = resolve(p.machine);
      const path = pathOf(p);
      const op = p.op;
      const write = WRITES.includes(op);
      if (write && !deps.grants.anyCovering(machine.deviceId, path, true)) {
        throw needsMachineFolder(machine, path, "read_write");
      }
      if (p.op === "write") contentOk(p);
      const base = {
        target: { kind: "path" as const, value: `${machine.name}:${path}`.slice(0, 1000) },
        // `tool` names the card as this machine's (its machine line, and the broker's
        // `approval.machine`); the run checks the device id, not the name.
        details: { tool: "machine_files", machine, path, op },
      };
      if (op === "request_folder" || op === "list" || op === "stat" || op === "read") {
        return { ...base, sideEffect: "read", summary: `${op} ${path} on ${machine.name}` };
      }
      if (op === "copy_to_host") {
        return {
          ...base,
          sideEffect: "write",
          summary: `Copy ${path} from ${machine.name} into the Library`,
          grantKey: `machine_files|copy_to_host|${machine.deviceId}`,
        };
      }
      const verb = op === "remove" ? "Remove" : op === "mkdir" ? "Make the folder" : "Write";
      return {
        ...base,
        // Every change on a machine asks, `once` only (the engine's `machine_files:change`
        // floor): no grant is ever kept for one, so none outlives a restart.
        sideEffect: "destructive",
        summary: `${verb} ${path} on ${machine.name}${p.op === "remove" && p.recursive === true ? " and everything in it" : ""}`,
        details: { ...base.details, ...changeFields(p) },
      };
    },
    async run(p, ctx) {
      const machine = resolve(p.machine);
      const path = pathOf(p);
      if (p.op === "request_folder") return requestFolder(machine, path, p, ctx);
      const grant = deps.grants.covering(machine.deviceId, ctx.threadId, path);
      const write = WRITES.includes(p.op);
      if (grant === undefined || (write && grant.mode !== "rw")) {
        throw needsMachineFolder(machine, path, write ? "read_write" : "read");
      }
      if (p.op === "write") contentOk(p);
      if (write) await approvedChange(machine, path, p, ctx);
      const client = live(machine);
      const call = async (capability: string, params: Record<string, unknown>) =>
        client.invoke(capability, params, {
          signal: ctx.signal,
          // fs.remove is destructive: the box refuses it without the approval that let it run.
          ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
        });
      // The granted folder is still the one the owner granted (not swapped for another).
      const moved = await folderMoved(machine, grant, call);
      if (moved !== undefined) return moved;
      if (p.op === "copy_to_host") return copyToHost(machine, path, call, ctx);
      const params: Record<string, unknown> = { path };
      for (const k of ["content", "encoding", "createParents", "recursive", "offset", "length"]) {
        const v = (p as Record<string, unknown>)[k];
        if (v !== undefined) params[k] = v;
      }
      // One read fits one frame.
      if (p.op === "read" && params.length === undefined) params.length = READ_CHUNK;
      const r = await call(`fs.${p.op}`, params);
      if (write) {
        await deps.audit?.append({
          kind: "machine.fs",
          actor: { type: "agent", runId: ctx.runId },
          subject: { runId: ctx.runId, threadId: ctx.threadId },
          data: {
            machine,
            op: p.op,
            path,
            ok: r.ok,
            ...(p.content === undefined ? {} : { bytes: Buffer.byteLength(p.content) }),
          },
        });
      }
      if (!r.ok) return machineError(machine, r.error);
      return { output: { machine, ...(r.result as object) }, provenance: "untrusted" };
    },
  });

  async function requestFolder(
    machine: ComputerMachineRef,
    asked: string,
    p: Params,
    ctx: ToolRunContext,
  ): Promise<ToolResult> {
    if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
      throw new PsycheError("forbidden", "only the owner's conversations can ask for a folder");
    }
    const access = p.access ?? "read";
    const client = live(machine);
    // The box says what the folder is: its real path (no link on the way, inside its ceiling, not
    // protected) and what is in it. The card shows and grants that, never the agent's string.
    const stat = await client.invoke("fs.stat", { path: asked }, { signal: ctx.signal });
    if (!stat.ok) return machineError(machine, stat.error);
    const st = stat.result as { kind?: unknown; path?: unknown; id?: unknown };
    const real = typeof st.path === "string" ? machinePath(st.path) : undefined;
    // Pinned at grant time: a folder swapped for another later is refused (`folder_moved`).
    const folderId =
      typeof st.id === "string" && /^[0-9a-f]{1,16}:[0-9a-f]{1,16}$/.test(st.id)
        ? st.id
        : undefined;
    if (st.kind !== "dir" || real === undefined) {
      throw new PsycheError("invalid_params", `${asked} is not a folder on ${machine.name}`);
    }
    const listing = await client.invoke("fs.list", { path: real }, { signal: ctx.signal });
    const entries = listing.ok
      ? ((listing.result as { entries?: { name?: unknown }[] }).entries ?? [])
      : [];
    const preview = entries
      .map((e) => (typeof e.name === "string" ? e.name.slice(0, 120) : ""))
      .filter((n) => n !== "")
      .slice(0, 20);
    const mode = access === "read_write" ? "rw" : "ro";
    const reason = (p.reason ?? "").slice(0, 500);
    const issued = await deps.broker.requestApproval({
      kind: "permission_request",
      summary:
        `Let Psyche ${mode === "rw" ? "read and change" : "read"} ${real} on ${machine.name}`.slice(
          0,
          300,
        ),
      details: {
        tool: "machine_files",
        need: { need: "machine_folder", machine, path: real, access },
        reason,
        machine,
        path: real,
        requestedPath: asked,
        access: mode,
        preview,
      },
      bindingHash: hashCanonical({
        tool: "machine_files.request_folder",
        machine: machine.deviceId,
        path: real,
        mode,
        reason,
        threadId: ctx.threadId,
        callId: ctx.callId,
      }),
      grantKey: MACHINE_FOLDERS_GRANT_KEY,
      requestedBy: {
        runId: ctx.runId,
        taskId: ctx.taskId ?? null,
        threadId: ctx.threadId,
        toolCallId: ctx.callId,
      },
      sideEffect: mode === "rw" ? "write" : "read",
      surfaces: [...deps.surfaces],
      scopesOffered: ["once"],
      taint: ctx.taint,
      ...(ctx.taint && ctx.taintSources !== undefined
        ? { taintSources: [...ctx.taintSources] }
        : {}),
    });
    const grant = () =>
      deps.grants.add({
        deviceId: machine.deviceId,
        path: real,
        mode,
        threadId: ctx.threadId,
        approvalId: issued.approval.id,
        grantedAt: Date.now(),
        ...(folderId === undefined ? {} : { folderId }),
      });
    if (ctx.mode === "unattended") {
      // Nothing waits on the card in an unattended run; the owner's tap still grants the folder
      // for this conversation (the next run in it finds the grant).
      void deps.broker
        .awaitDecision(issued.approval.id)
        .then((d) => {
          if (d.status === "approved") grant();
        })
        .catch(() => undefined);
      return { output: { granted: false, status: "queued", machine }, provenance: "trusted" };
    }
    const done = await deps.broker.awaitDecision(issued.approval.id, ctx.signal);
    if (done.status !== "approved") {
      return { output: { granted: false, status: done.status, machine }, provenance: "trusted" };
    }
    grant();
    // The path is the box's own answer: untrusted, like everything a machine returns.
    return {
      output: { granted: true, machine, path: real, access, next: "retry the file call" },
      provenance: "untrusted",
    };
  }

  async function copyToHost(
    machine: ComputerMachineRef,
    path: string,
    call: (capability: string, params: Record<string, unknown>) => ReturnType<NodeClient["invoke"]>,
    ctx: ToolRunContext,
  ): Promise<ToolResult> {
    const chunks: Buffer[] = [];
    let total = 0;
    let etag: string | undefined;
    for (;;) {
      // Chunks that each fit one frame, streamed up to the copy limit.
      const r = await call("fs.read", {
        path,
        encoding: "base64",
        offset: total,
        length: READ_CHUNK,
        ...(etag === undefined ? {} : { etag }),
      });
      if (!r.ok) return machineError(machine, r.error);
      const res = r.result as { content?: unknown; eof?: unknown; etag?: unknown; size?: unknown };
      if (typeof res.content !== "string") return machineError(machine, { code: "internal" });
      if (etag === undefined && typeof res.size === "number" && res.size > MACHINE_COPY_MAX_BYTES) {
        throw new PsycheError(
          "invalid_params",
          `${path} is larger than ${MACHINE_COPY_MAX_BYTES} bytes; it was not copied`,
        );
      }
      etag = typeof res.etag === "string" ? res.etag : etag;
      const chunk = Buffer.from(res.content, "base64");
      total += chunk.length;
      if (total > MACHINE_COPY_MAX_BYTES) {
        throw new PsycheError(
          "invalid_params",
          `${path} grew past ${MACHINE_COPY_MAX_BYTES} bytes`,
        );
      }
      chunks.push(chunk);
      if (res.eof === true || chunk.length === 0) break;
    }
    const data = Buffer.concat(chunks);
    const saved = await deps.library.save({
      name: posix.basename(path) || "file",
      data,
      machine,
      path,
      threadId: ctx.threadId,
    });
    await deps.audit?.append({
      kind: "machine.copy_to_host",
      actor: { type: "agent", runId: ctx.runId },
      subject: { runId: ctx.runId, threadId: ctx.threadId },
      data: { machine, path, bytes: data.length, libraryItemId: saved.libraryItemId },
    });
    return {
      output: {
        machine,
        path,
        bytes: data.length,
        libraryItemId: saved.libraryItemId,
        quarantined: true,
      },
      provenance: "untrusted",
    };
  }
}
