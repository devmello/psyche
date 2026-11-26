import { type MemoryStore, PsycheError } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { type AgentToolRegistration, defineTool } from "../registry.ts";
import { isProtectedPath } from "./services.ts";

// No minLength: the store's own rule counts characters, not UTF-16 units, so a two-character
// Han name is the store's call (`forget needs at least N characters`).
const ForgetInput = Type.Object(
  {
    subject: Type.String({ maxLength: 500 }),
    dry_run: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** The card binds to this text: case and spacing do not make a different forget. */
const normalize = (subject: string) => subject.trim().replace(/\s+/g, " ").toLowerCase();

const DAILY_NOTE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/i;

export interface ForgetToolOptions {
  /** Incognito threads write nothing to memory. */
  isIncognito?: (threadId: string) => boolean;
}

/** The store, plus the pause flag the real store has (a fake has none). */
type ForgetStore = Pick<MemoryStore, "forget"> & { paused?: boolean };

/**
 * `memory_forget` (QA 4): the owner said "forget that ..." in chat. It runs the same store forget
 * the Memory page's Forget runs (USER.md lines, claims, search chunks, graph, lessons, saved
 * chats), so the fact is gone from everywhere. It is a destructive call with its own "Forget
 * everywhere" card, once only, bound to the subject, and the run executes exactly that subject.
 * The store sees the agent as the actor: its caps (rows, characters, people, lessons, protected
 * files) hold unless that card was approved for this subject. The result says what was removed,
 * so the agent only claims "forgotten" when rows were removed.
 */
export function forgetTool(
  store: ForgetStore,
  options: ForgetToolOptions = {},
): AgentToolRegistration {
  return defineTool({
    name: "memory_forget",
    description:
      'Forget something the owner told you or that Psyche remembered: removes every mention of `subject` (a distinctive phrase such as "prefers tabs over spaces") from memory, USER.md, people and lessons. Use it when the owner says "forget ...". Pass dry_run first only when unsure what it would remove. Say it is forgotten only when the result says it forgot.',
    input: ForgetInput,
    sideEffect: "destructive",
    describeCall: (p: Static<typeof ForgetInput>) =>
      p.dry_run === true
        ? { sideEffect: "none", summary: `Checked what forgetting "${p.subject}" would remove` }
        : {
            sideEffect: "destructive",
            kind: "memory_forget",
            summary: `Forget "${p.subject}"`,
            bindingFields: { subject: normalize(p.subject) },
            // One subject, one card: an approval for "Sam" never covers "Alex".
            grantKey: `memory_forget|${normalize(p.subject)}`,
            details: {
              subject: p.subject,
              covers: "Every mention in memory, people and lessons. This can't be undone.",
            },
          },
    run: async (p, ctx) => {
      const dry = p.dry_run === true;
      if (!dry) {
        // Forgetting is the owner's call, in the owner's own turn: never after reading content
        // someone else wrote, never for another person's request, never in incognito or while
        // memory is paused.
        if (ctx.taint) {
          throw new PsycheError(
            "policy_denied",
            "a turn that read untrusted content cannot forget memory; ask the owner to do it in Memory",
          );
        }
        if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
          throw new PsycheError("policy_denied", "only the owner can forget memory");
        }
        if (options.isIncognito?.(ctx.threadId) === true) {
          throw new PsycheError(
            "policy_denied",
            "this is an incognito thread; memory writes are off",
          );
        }
        if (store.paused === true) {
          throw new PsycheError("policy_denied", "memory is paused by the owner");
        }
      }
      let r: Awaited<ReturnType<MemoryStore["forget"]>>;
      try {
        r = await store.forget(p.subject, {
          dryRun: dry,
          actor: "agent",
          link: {
            threadId: ctx.threadId,
            runId: ctx.runId,
            toolCallId: ctx.callId,
            tool: "memory_forget",
          },
          ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
        });
      } catch (err) {
        const e = PsycheError.from(err);
        if (e.code === "approval_required") {
          // A plain answer, not a failure to retry: the model tells the owner where to do it.
          return {
            output: {
              forgotten: false,
              message: `Not forgotten. ${e.message}. Tell the owner to forget it on the Memory page.`,
            },
            provenance: "trusted",
          };
        }
        throw err;
      }
      const removed = r.retractedClaimIds.length + r.removedChunkIds.length;
      const files = r.files ?? [];
      const rows = Object.values(r.counts ?? {}).reduce((a, n) => a + n, 0);
      const found = removed > 0 || files.length > 0 || rows > 0;
      return {
        output: {
          forgotten: !dry && found,
          ...(dry ? { wouldRemove: found } : {}),
          claims: r.retractedClaimIds.length,
          chunks: r.removedChunkIds.length,
          files,
          message: !found
            ? "Nothing matched, so nothing was forgotten."
            : dry
              ? `Would remove ${removed} remembered item(s) from ${files.length} file(s).`
              : `Forgot it: removed ${removed} remembered item(s) from ${files.length} file(s).`,
        },
        // File names can come from a tainted turn's notes: only known files are trusted.
        provenance: files.every((f) => isProtectedPath(f) || DAILY_NOTE.test(f))
          ? "trusted"
          : "untrusted",
      };
    },
  });
}
