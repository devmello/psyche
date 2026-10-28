import type { GraphCitationSource, QuarantineReason } from "@psyche/protocol";
import type {
  EverythingStore,
  ProposeEdgeInput,
  ProposeEdgeOutcome,
  ProposeFactInput,
  ProposeOutcome,
} from "../graph/everything.ts";

/**
 * The only thing the extraction validator can write through (docs/design/everything-memory-2026.md
 * §5.1 stage 3). Exactly three methods. It has no handle to settings, the agent, identifiers,
 * merges, loops, USER.md, MEMORY.md, trusted sources or the network, and cannot raise a fact's
 * trust: everything it stores is `pending` unless the caller proves owner-authored provenance, and
 * nothing is ever `owner`. `sink.test.ts` pins the shape: adding a method fails the test.
 */
export interface ExtractionSink {
  proposeFact(input: SinkFact): ProposeOutcome;
  proposeEdge(input: SinkEdge): ProposeEdgeOutcome;
  quarantine(input: SinkQuarantine): void;
}

export type SinkFact = Omit<ProposeFactInput, "runId" | "extractor">;
export type SinkEdge = ProposeEdgeInput;

export interface SinkQuarantine {
  source: GraphCitationSource;
  sourceRef: string;
  senderEntityId?: string | null;
  reasons: QuarantineReason[];
  excerpt: string;
}

/** The method names of `ExtractionSink`; the interface test compares against this. */
export const EXTRACTION_SINK_METHODS = ["proposeEdge", "proposeFact", "quarantine"] as const;

export function createExtractionSink(
  store: EverythingStore,
  ctx: { runId?: string; extractor?: string } = {},
): ExtractionSink {
  return Object.freeze({
    proposeFact: (input: SinkFact) =>
      store.proposeFact({
        ...input,
        // Whatever the caller says, the sink never writes an owner fact.
        provenance: input.provenance === "untrusted" ? "untrusted" : "agent",
        runId: ctx.runId ?? null,
        ...(ctx.extractor === undefined ? {} : { extractor: ctx.extractor }),
      }),
    proposeEdge: (input: SinkEdge) =>
      store.proposeEdge({
        ...input,
        provenance: input.provenance === "untrusted" ? "untrusted" : "agent",
      }),
    quarantine: (input: SinkQuarantine) => {
      store.quarantine(input);
    },
  });
}
