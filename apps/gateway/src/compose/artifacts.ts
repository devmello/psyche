import {
  type AgentToolRegistration,
  defineTool,
  type TurnContextProvider,
  type TurnToolContext,
} from "@psyche/agent-core";
import { listArtifactsPage, listArtifactVersions, type PsycheDb } from "@psyche/db";
import {
  ArtifactOp,
  type ArtifactVersion,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { ArtifactStore, type ArtifactWrite } from "../artifacts/store.ts";
import type { Call, HandlerDef } from "../context.ts";
import { decodeOffset, encodeOffset } from "../handlers/threads.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Canvas artifacts (docs/design/chat-experience-2026.md §4.3–4.5): the `artifacts.*` methods for
 * the canvas (writes there are the user's) and the agent's `artifact.create / update / read`
 * tools. The model gets an `ArtifactRef` back, never the body, and reads windows on demand.
 */

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
/** A read without a window returns at most this much; the model pages with `from`/`to`. */
const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 40_000;
/** Missed ops a conflict hands back inline; bigger ones say "read it". */
const CONFLICT_OPS_CHARS = 4_000;

/** One-based inclusive window over `content`'s lines, capped. */
export function windowOf(
  content: string,
  from = 1,
  to?: number,
): { text: string; from: number; to: number; totalLines: number; truncated: boolean } {
  const lines = content.split("\n");
  const totalLines = content === "" ? 0 : lines.length;
  const start = Math.max(1, from);
  let end = Math.min(totalLines, to ?? start + READ_MAX_LINES - 1, start + READ_MAX_LINES - 1);
  let text = lines.slice(start - 1, end).join("\n");
  let truncated = end < Math.min(to ?? totalLines, totalLines);
  if (text.length > READ_MAX_CHARS) {
    text = text.slice(0, READ_MAX_CHARS);
    end = start + text.split("\n").length - 1;
    truncated = true;
  }
  return { text, from: start, to: end, totalLines, truncated };
}

function writtenResult(w: ArtifactWrite): MethodResult<"artifacts.update"> {
  return { artifact: w.artifact, ref: w.ref, ...(w.conflict ? { conflict: w.conflict } : {}) };
}

export function artifactHandlers(store: ArtifactStore): Record<string, HandlerDef> {
  const user = { author: "user" as const };
  return {
    "artifacts.get": {
      run: (_c: Call, p: MethodParams<"artifacts.get">): MethodResult<"artifacts.get"> => ({
        artifact: store.get(p.artifactId).artifact,
      }),
    },
    "artifacts.list": {
      run: (_c: Call, p: MethodParams<"artifacts.list">): MethodResult<"artifacts.list"> => {
        const offset = decodeOffset(p.cursor);
        const limit = Math.min(p.limit ?? DEFAULT_PAGE, MAX_PAGE);
        const page = store.list({
          offset,
          limit,
          ...(p.threadId === undefined ? {} : { threadId: p.threadId }),
        });
        return {
          artifacts: page.items,
          nextCursor: page.hasMore ? encodeOffset(offset + page.items.length) : null,
        };
      },
    },
    "artifacts.read": {
      run: (_c: Call, p: MethodParams<"artifacts.read">): MethodResult<"artifacts.read"> => {
        const a = store.get(p.artifactId).artifact;
        const at = store.contentAt(p.artifactId, p.version);
        const totalLines = at.content === "" ? 0 : at.content.split("\n").length;
        const content =
          p.lines === undefined
            ? at.content
            : at.content
                .split("\n")
                .slice(p.lines.from - 1, p.lines.to)
                .join("\n");
        return {
          artifactId: a.id,
          version: at.version,
          type: a.type,
          content,
          totalLines,
          ...(at.view === null ? {} : { view: at.view }),
        };
      },
    },
    "artifacts.versions": {
      run: (
        _c: Call,
        p: MethodParams<"artifacts.versions">,
      ): MethodResult<"artifacts.versions"> => ({
        versions: store.versions(p.artifactId),
      }),
    },
    "artifacts.create": {
      run: async (
        _c: Call,
        p: MethodParams<"artifacts.create">,
      ): Promise<MethodResult<"artifacts.create">> =>
        writtenResult(
          await store.create(
            {
              type: p.type,
              title: p.title,
              content: p.content,
              ...(p.language === undefined ? {} : { language: p.language }),
              ...(p.threadId === undefined ? {} : { threadId: p.threadId }),
            },
            user,
          ),
        ),
    },
    "artifacts.update": {
      run: async (
        _c: Call,
        p: MethodParams<"artifacts.update">,
      ): Promise<MethodResult<"artifacts.update">> =>
        writtenResult(await store.update(p.artifactId, p.base, p.ops, user)),
    },
    "artifacts.restore": {
      run: async (
        _c: Call,
        p: MethodParams<"artifacts.restore">,
      ): Promise<MethodResult<"artifacts.restore">> =>
        writtenResult(await store.restore(p.artifactId, p.version, user)),
    },
  };
}

const CreateInput = Type.Object({
  type: Type.Union([
    Type.Literal("doc"),
    Type.Literal("code"),
    Type.Literal("table"),
    Type.Literal("chart"),
    Type.Literal("diagram"),
    Type.Literal("diff"),
    Type.Literal("html"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  content: Type.String({
    description:
      "doc: markdown. code: the source. table: CSV with a header row, or JSON {columns, rows}. chart: JSON {kind: bar|line|area|pie, categories, series: [{name, values}]}. diagram: Mermaid text. diff: a unified diff. html: one self-contained HTML document (inline CSS and script only; it runs in a sandbox with no network, so never reference outside URLs).",
  }),
  language: Type.Optional(Type.String({ maxLength: 40, description: "code only, e.g. ts, py" })),
});

const UpdateInput = Type.Object({
  artifactId: Type.String(),
  base: Type.Integer({ minimum: 1, description: "The version your ops apply to." }),
  ops: Type.Array(ArtifactOp, { minItems: 1, maxItems: 200 }),
});

const ReadInput = Type.Object({
  artifactId: Type.String(),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
  from: Type.Optional(Type.Integer({ minimum: 1, description: "First line (1-based)." })),
  to: Type.Optional(Type.Integer({ minimum: 1, description: "Last line, inclusive." })),
});

const toolError = (e: unknown): ToolResult => {
  const err = e instanceof PsycheError ? e : new PsycheError("internal", String(e));
  return {
    output: { error: { code: err.code, message: err.message } },
    isError: true,
    provenance: "trusted",
  };
};

/** What a conflict tells the model: the missed versions, with their ops only when small. */
function conflictOutput(w: ArtifactWrite): unknown {
  const missed = (w.conflict?.missed ?? []).map((v: ArtifactVersion) => {
    const ops = v.ops === undefined ? undefined : JSON.stringify(v.ops);
    return {
      version: v.version,
      author: v.author,
      summary: v.summary,
      ...(ops !== undefined && ops.length <= CONFLICT_OPS_CHARS ? { ops: v.ops } : {}),
    };
  });
  return {
    conflict: true,
    latest: w.ref.version,
    missed,
    note: "Nothing was written. Re-apply your edit on the latest version (read it if the missed ops are not shown).",
  };
}

export function artifactTools(store: ArtifactStore): AgentToolRegistration[] {
  return [
    defineTool({
      name: "artifact.create",
      description:
        "Put substantial standalone output (a document, a code file, a table) in the canvas beside the chat instead of writing it into your reply. Returns a reference {artifactId, version, summary}, not the content; in chat, say one line about what you made. Edit it later with artifact.update, never by re-sending it.",
      input: CreateInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Created ${p.type} "${p.title}"` }),
      run: async (p, ctx) => {
        try {
          const w = await store.create(
            {
              type: p.type,
              title: p.title,
              content: p.content,
              threadId: ctx.threadId,
              untrusted: ctx.taint,
              ...(p.language === undefined ? {} : { language: p.language }),
            },
            { author: "agent", runId: ctx.runId, toolCallId: ctx.callId },
          );
          (ctx as Partial<TurnToolContext>).turn?.emitBlock({
            type: "artifact",
            artifactId: w.artifact.id,
            preview: p.type === "table" ? "sheet" : p.type === "chart" ? "dashboard" : "markdown",
          });
          return { output: w.ref, provenance: "trusted" };
        } catch (e) {
          return toolError(e);
        }
      },
    }),
    defineTool({
      name: "artifact.update",
      description:
        'Edit a canvas artifact with small ops on version `base`. Text: {op:"replace", old, new} (old must match exactly once; include enough context), {op:"insert", after, text} (after="" inserts at the start), {op:"rewrite", content} only when most of it changes. Charts: {op:"patch", patch} is a JSON merge patch onto the spec (arrays are replaced whole; null deletes a key). Tables (A1 = first data row): {op:"set", cell:"B3", value}, {op:"setRange", range, values}, {op:"addRows", rows, at?}, {op:"deleteRows", at, count}, {op:"addColumn", name, values?}, {op:"view", view:{sort?, filter?}}. If the user edited it since `base`, you get a conflict with what changed; nothing is written.',
      input: UpdateInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Edited artifact (${p.ops.length} ops)` }),
      run: async (p, ctx) => {
        try {
          const w = await store.update(
            p.artifactId,
            p.base,
            p.ops,
            { author: "agent", runId: ctx.runId, toolCallId: ctx.callId },
            { untrusted: ctx.taint },
          );
          return {
            output: w.conflict === undefined ? w.ref : conflictOutput(w),
            provenance: "trusted",
          };
        } catch (e) {
          return toolError(e);
        }
      },
    }),
    defineTool({
      name: "artifact.read",
      description: `Read a canvas artifact's content, the latest version unless \`version\` is given. Returns at most ${READ_MAX_LINES} lines; pass from/to to read a window. Read only what you need.`,
      input: ReadInput,
      sideEffect: "none",
      run: async (p) => {
        try {
          const a = store.get(p.artifactId).artifact;
          const at = store.contentAt(p.artifactId, p.version);
          const w = windowOf(at.content, p.from, p.to);
          return {
            output: {
              artifactId: a.id,
              version: at.version,
              type: a.type,
              lines: `${w.from}-${w.to} of ${w.totalLines}`,
              ...(w.truncated ? { truncated: true } : {}),
              ...(at.view === null ? {} : { view: at.view }),
              content: w.text,
            },
            // Content derived from tainted input stays tainted when read back.
            provenance: a.untrusted === true ? "untrusted" : "trusted",
          };
        } catch (e) {
          return toolError(e);
        }
      },
    }),
  ];
}

/** Artifacts the canvas manifest lists per turn (most recently updated first). */
const MANIFEST_MAX = 8;
/** Owner edits whose ops fit in this many characters are shown inline. */
const EDIT_OPS_CHARS = 600;

/**
 * The canvas manifest (chat-experience-2026 §4.3 rules 3 and 4): once per owner turn, one line
 * per artifact in the thread (id, title, type, version) and the owner's canvas edits since the
 * agent's last version, as the same op format, each reported once. No bodies: the model reads
 * what it needs. Titles of artifacts made from untrusted input are withheld, so the section
 * stays owner/system data.
 */
export function artifactContextProvider(db: PsycheDb): TurnContextProvider {
  const reported = new Map<string, number>();
  return {
    name: "canvas",
    async provide({ threadId }) {
      const { items } = listArtifactsPage(db, { threadId, limit: MANIFEST_MAX });
      if (items.length === 0) return undefined;
      const lines = items.map((a) =>
        a.untrusted === true
          ? `- ${a.id} ${a.type} v${a.version} [made from untrusted input; title withheld]`
          : `- ${a.id} "${a.title.replace(/[\n"]/g, " ")}" ${a.type} v${a.version}`,
      );
      const edits: string[] = [];
      for (const a of items) {
        const versions = listArtifactVersions(db, a.id, reported.get(a.id) ?? 0).map(
          (v) => v.version,
        );
        const lastOwn = versions.findLastIndex((v) => v.author !== "user");
        const userEdits = versions.slice(lastOwn + 1).filter((v) => v.author === "user");
        reported.set(a.id, a.version);
        for (const v of userEdits) {
          const ops = v.ops === undefined ? "" : JSON.stringify(v.ops);
          edits.push(
            `- ${a.id} v${v.version}: ${v.summary}${ops !== "" && ops.length <= EDIT_OPS_CHARS ? ` ops ${ops}` : ""}`,
          );
        }
      }
      const text = [
        "Canvas artifacts in this chat (artifact.read to see content; artifact.update with base = the version shown):",
        ...lines,
        ...(edits.length === 0
          ? []
          : ["The owner edited these in the canvas since your last version:", ...edits]),
      ].join("\n");
      return {
        trusted: true,
        source: { sourceKind: "canvas" },
        sections: [{ title: "Canvas", text }],
      };
    },
  };
}

/** The artifacts part: the store, its methods, and the agent's tools. */
export function composeArtifacts(services: ComposeServices): ComposedPart {
  const store = new ArtifactStore({
    db: services.db,
    home: services.home,
    publish: (artifact, version) =>
      services.publish("artifact.updated", { artifact, version }, artifact.threadId ?? undefined),
  });
  const unregister = artifactTools(store).map((t) => services.tools.register(t));
  return {
    handlers: artifactHandlers(store),
    stop: () => {
      for (const u of unregister) u();
    },
  };
}
