import { type MemoryStore, PsycheError } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { type AgentToolRegistration, defineTool } from "../registry.ts";

const ForgetInput = Type.Object(
  {
    subject: Type.String({ minLength: 3, maxLength: 500 }),
    dry_run: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** The card binds to this text: case and spacing do not make a different forget. */
const normalize = (subject: string) => subject.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * `memory_forget` (QA 4): the owner said "forget that ..." in chat. It runs the same store forget
 * the Memory page's Forget runs (USER.md lines, claims, search chunks, graph, lessons, saved
 * chats), so the fact is gone from everywhere, not just from one file. It is a destructive call
 * with its own card bound to the subject, and the run executes exactly that subject. The result
 * says what was removed, so the agent only claims "forgotten" when rows were removed.
 */
export function forgetTool(store: Pick<MemoryStore, "forget">): AgentToolRegistration {
  return defineTool({
    name: "memory_forget",
    description:
      'Forget something the owner told you or that Psyche remembered: removes every mention of `subject` (a distinctive phrase such as "prefers tabs over spaces") from memory, USER.md, people and lessons. Use it when the owner says "forget ...". Pass dry_run first only when unsure what it would remove. Say it is forgotten only when the result reports removed rows.',
    input: ForgetInput,
    sideEffect: "destructive",
    describeCall: (p: Static<typeof ForgetInput>) =>
      p.dry_run === true
        ? { sideEffect: "none", summary: `Checked what forgetting "${p.subject}" would remove` }
        : {
            sideEffect: "destructive",
            summary: `Forget "${p.subject}"`,
            bindingFields: { subject: normalize(p.subject) },
            grantKey: "memory_forget",
          },
    run: async (p, ctx) => {
      const dry = p.dry_run === true;
      if (!dry) {
        // Forgetting is the owner's call, in the owner's own turn: never after reading content
        // someone else wrote, and never for another person's or an app's request.
        if (ctx.taint) {
          throw new PsycheError(
            "policy_denied",
            "a turn that read untrusted content cannot forget memory; ask the owner to do it in Memory",
          );
        }
        if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
          throw new PsycheError("policy_denied", "only the owner can forget memory");
        }
      }
      const r = await store.forget(p.subject, { dryRun: dry });
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
        provenance: "trusted",
      };
    },
  });
}
