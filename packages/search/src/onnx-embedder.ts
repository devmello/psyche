import { readFile } from "node:fs/promises";
import type { SearchEmbedder } from "./semantic.ts";

/**
 * The built-in on-device embedder (docs/design/search-2026.md §3): a small ONNX sentence-embedding
 * model run on the CPU by `onnxruntime-node` (its inference runs off the JS thread), tokenized by
 * `@huggingface/tokenizers` (pure JS). Both load lazily, only when the owner turns semantic search
 * on, so nothing native loads otherwise. Model files come from the catalog below, pinned to a
 * Hugging Face revision and SHA-256, and download on first enable (the Gateway's ModelManager).
 */

export interface EmbeddingModelFile {
  /** Path under `$PSYCHE_HOME/models/`. */
  file: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface EmbeddingModelSpec {
  id: string;
  label: string;
  dims: number;
  /** Tokens per input; longer inputs are truncated. */
  maxTokens: number;
  queryPrefix: string;
  documentPrefix: string;
  /** Cosine below which a semantic-only hit is noise for this model. */
  floor: number;
  padId: number;
  eosId: number;
  license: string;
  model: EmbeddingModelFile;
  tokenizer: EmbeddingModelFile;
  /** `tokenizer_config.json` of the pinned revision (small; inlined). */
  tokenizerConfig: Record<string, unknown>;
}

const E5_REV = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const E5_BASE = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${E5_REV}`;

export const EMBEDDING_MODELS: readonly EmbeddingModelSpec[] = [
  {
    // intfloat/multilingual-e5-small (MIT), int8 ONNX export by Xenova: ~100 languages, 384 dims.
    id: "multilingual-e5-small",
    label: "Multilingual E5 small (118 MB)",
    dims: 384,
    maxTokens: 512,
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    // e5 similarities cluster high (0.7–0.9): only close matches count as related.
    floor: 0.8,
    padId: 1,
    eosId: 2,
    license: "MIT",
    model: {
      file: "embeddings/multilingual-e5-small/model_quantized.onnx",
      url: `${E5_BASE}/onnx/model_quantized.onnx`,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
      sizeBytes: 118_308_185,
    },
    tokenizer: {
      file: "embeddings/multilingual-e5-small/tokenizer.json",
      url: `${E5_BASE}/tokenizer.json`,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      sizeBytes: 17_082_730,
    },
    tokenizerConfig: {
      bos_token: "<s>",
      clean_up_tokenization_spaces: true,
      cls_token: "<s>",
      eos_token: "</s>",
      mask_token: {
        __type: "AddedToken",
        content: "<mask>",
        lstrip: true,
        normalized: true,
        rstrip: false,
        single_word: false,
      },
      model_max_length: 512,
      pad_token: "<pad>",
      sep_token: "</s>",
      sp_model_kwargs: {},
      tokenizer_class: "XLMRobertaTokenizer",
      unk_token: "<unk>",
    },
  },
];

export const DEFAULT_EMBEDDING_MODEL = "multilingual-e5-small";

export function embeddingModel(id: string): EmbeddingModelSpec | undefined {
  return EMBEDDING_MODELS.find((m) => m.id === id);
}

export interface OnnxEmbedderOptions {
  spec: EmbeddingModelSpec;
  modelPath: string;
  tokenizerPath: string;
  /** CPU threads for one inference (default 2: background work stays light on battery). */
  threads?: number;
  /** Texts per inference call (default 8). */
  batchSize?: number;
}

type OrtModule = typeof import("onnxruntime-node");
type Session = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

/** Loads the model and tokenizer; throws when the runtime cannot load on this machine. */
export async function createOnnxEmbedder(
  options: OnnxEmbedderOptions,
): Promise<SearchEmbedder & { release(): Promise<void> }> {
  const { spec } = options;
  const ort: OrtModule = await import("onnxruntime-node");
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(options.tokenizerPath, "utf8")),
    spec.tokenizerConfig,
  );
  const session: Session = await ort.InferenceSession.create(options.modelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: Math.max(1, options.threads ?? 2),
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const batchSize = Math.max(1, options.batchSize ?? 8);
  // One inference at a time; a waiting query goes before waiting document batches.
  const lane = new PriorityLane();

  const run = async (texts: string[]): Promise<Float32Array[]> => {
    const encoded: number[][] = texts.map((t) => {
      const ids: number[] = tokenizer.encode(t).ids;
      return ids.length > spec.maxTokens ? [...ids.slice(0, spec.maxTokens - 1), spec.eosId] : ids;
    });
    const len = Math.max(1, ...encoded.map((e) => e.length));
    const n = encoded.length;
    const ids = new BigInt64Array(n * len).fill(BigInt(spec.padId));
    const mask = new BigInt64Array(n * len);
    encoded.forEach((e, b) => {
      e.forEach((id, i) => {
        ids[b * len + i] = BigInt(id);
        mask[b * len + i] = 1n;
      });
    });
    const feeds: Record<string, InstanceType<OrtModule["Tensor"]>> = {
      input_ids: new ort.Tensor("int64", ids, [n, len]),
      attention_mask: new ort.Tensor("int64", mask, [n, len]),
    };
    if (session.inputNames.includes("token_type_ids"))
      feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(n * len), [n, len]);
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0] as string];
    if (hidden === undefined) throw new Error("the embedding model returned no output");
    const data = hidden.data as Float32Array;
    const dims = hidden.dims[2] ?? spec.dims;
    return encoded.map((e, b) => meanPool(data, b, len, dims, e.length));
  };

  return {
    model: `builtin/${spec.id}`,
    floor: spec.floor,
    /** Frees the ONNX session (used by `lazyEmbedder` when idle). */
    release: () => session.release(),
    async embed(texts, purpose, signal) {
      const prefix = purpose === "query" ? spec.queryPrefix : spec.documentPrefix;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const part = texts.slice(i, i + batchSize).map((t) => prefix + t);
        out.push(...(await lane.run(purpose === "query" ? 0 : 1, () => run(part), signal)));
      }
      return out;
    },
  };
}

/** Mean of the token vectors of row `b` (padding excluded), unit length. */
export function meanPool(
  data: Float32Array,
  b: number,
  len: number,
  dims: number,
  tokens: number,
): Float32Array {
  const v = new Float32Array(dims);
  for (let t = 0; t < tokens; t++) {
    const off = (b * len + t) * dims;
    for (let j = 0; j < dims; j++) v[j] = (v[j] as number) + (data[off + j] as number);
  }
  let norm = 0;
  for (let j = 0; j < dims; j++) {
    v[j] = (v[j] as number) / Math.max(1, tokens);
    norm += (v[j] as number) ** 2;
  }
  const len2 = Math.sqrt(norm);
  if (len2 > 0) for (let j = 0; j < dims; j++) v[j] = (v[j] as number) / len2;
  return v;
}

/** Runs one task at a time; lower priority numbers go first among waiting tasks. */
export class PriorityLane {
  #busy = false;
  #waiting: { priority: number; start: () => void }[] = [];

  async run<T>(priority: number, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#busy) {
      await new Promise<void>((resolve, reject) => {
        const entry = { priority, start: resolve };
        const at = this.#waiting.findIndex((w) => w.priority > priority);
        if (at === -1) this.#waiting.push(entry);
        else this.#waiting.splice(at, 0, entry);
        signal?.addEventListener("abort", () => {
          const i = this.#waiting.indexOf(entry);
          if (i !== -1) {
            this.#waiting.splice(i, 1);
            reject(new Error("aborted"));
          }
        });
      });
    }
    this.#busy = true;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#busy = false;
      else next.start();
    }
  }
}
