import type {
  CallOptions,
  EmbedOptions,
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  ModelRef,
  ModelRequest,
} from "@psyche/protocol";

export type ScriptedTurn = ModelEvent[] | ((request: ModelRequest) => ModelEvent[]);

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  toolCalling: true,
  vision: false,
  reasoning: true,
  embeddings: true,
  promptCaching: false,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

const DEFAULT_TURN: ModelEvent[] = [
  { type: "text_delta", text: "ok" },
  {
    type: "usage",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

/**
 * Scripted model provider. Each `stream` call consumes the next scripted turn (a list of
 * events, or a function of the request); when the script is exhausted it replies "ok". Missing
 * `finish` events are appended, so the stream invariant always holds. Every request is recorded.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id: string;
  readonly requests: ModelRequest[] = [];
  #turns: ScriptedTurn[] = [];
  #capabilities: ModelCapabilities;

  constructor(options: { id?: string; capabilities?: Partial<ModelCapabilities> } = {}) {
    this.id = options.id ?? "fake";
    this.#capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  /** Replace the script. */
  static script(turns: ScriptedTurn[], options?: { id?: string }): FakeModelProvider {
    return new FakeModelProvider(options).script(turns);
  }

  script(turns: ScriptedTurn[]): this {
    this.#turns = [...turns];
    return this;
  }

  /** Append turns to the script. */
  enqueue(...turns: ScriptedTurn[]): this {
    this.#turns.push(...turns);
    return this;
  }

  get remainingTurns(): number {
    return this.#turns.length;
  }

  async *stream(request: ModelRequest, options: CallOptions = {}): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(request));
    const turn = this.#turns.shift() ?? DEFAULT_TURN;
    const events = typeof turn === "function" ? turn(request) : turn;
    const signal = options.signal;
    for (const event of events) {
      // Yield to the event loop so consumers can abort between events.
      await Promise.resolve();
      if (signal?.aborted === true) {
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      yield structuredClone(event);
      if (event.type === "finish") return;
    }
    if (signal?.aborted === true) {
      yield { type: "finish", reason: "cancelled" };
      return;
    }
    yield { type: "finish", reason: "stop" };
  }

  /** Deterministic 8-dim bag-of-characters embedding, L2-normalized. */
  async embed(texts: string[], _options?: EmbedOptions): Promise<number[][]> {
    return texts.map((text) => fakeEmbedding(text));
  }

  async capabilities(_model?: ModelRef): Promise<ModelCapabilities> {
    return { ...this.#capabilities };
  }
}

export function fakeEmbedding(text: string, dims = 8): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const ch of text.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    v[code % dims] = (v[code % dims] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
