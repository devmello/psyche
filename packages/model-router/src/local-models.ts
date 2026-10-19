/**
 * RAM-fit guidance and suggested local models (architecture §4.4, B4). Names were checked
 * against ollama.com/library on 2026-10-19; Mistral Small 4 is not in Ollama's library, so it
 * is listed with its Hugging Face GGUF repo for llama.cpp. Sizes are Ollama's 4-bit downloads.
 */

export interface SuggestedModel {
  label: string;
  /** Ref for the default runtime (`ollama/<tag>`), or a Hugging Face repo for llama.cpp. */
  ref: string;
  runtime: "ollama" | "llama.cpp";
  downloadGb: number;
  /** Smallest unified memory that runs it with room for context. */
  minRamGb: number;
  notes: string;
}

export interface RamTier {
  minRamGb: number;
  guidance: string;
  models: SuggestedModel[];
}

export const SUGGESTED_LOCAL_MODELS: SuggestedModel[] = [
  {
    label: "Gemma 4 E4B",
    ref: "ollama/gemma4:e4b",
    runtime: "ollama",
    downloadGb: 9.5,
    minRamGb: 16,
    notes: "Small, vision, tools",
  },
  {
    label: "Gemma 4 12B",
    ref: "ollama/gemma4:12b",
    runtime: "ollama",
    downloadGb: 8,
    minRamGb: 16,
    notes: "Best tool use at 16 GB",
  },
  {
    label: "gpt-oss-20b",
    ref: "ollama/gpt-oss:20b",
    runtime: "ollama",
    downloadGb: 14,
    minRamGb: 16,
    notes: "Tight at 16 GB; reasoning low/medium/high",
  },
  {
    label: "Qwen3.8-27B",
    ref: "ollama/qwen3.8:27b",
    runtime: "ollama",
    downloadGb: 18,
    minRamGb: 32,
    notes: "Strongest dense model at 32 GB; vision, tools, thinking",
  },
  {
    label: "Gemma 4 31B",
    ref: "ollama/gemma4:31b",
    runtime: "ollama",
    downloadGb: 20,
    minRamGb: 32,
    notes: "Dense, 256K context",
  },
  {
    label: "Gemma 4 26B-A4B",
    ref: "ollama/gemma4:26b",
    runtime: "ollama",
    downloadGb: 19,
    minRamGb: 32,
    notes: "MoE, fast",
  },
  {
    label: "GLM-4.7-Flash",
    ref: "ollama/glm-4.7-flash:q4",
    runtime: "ollama",
    downloadGb: 19,
    minRamGb: 32,
    notes: "30B-A3B MoE, fast agent loops",
  },
  {
    label: "gpt-oss-120b",
    ref: "ollama/gpt-oss:120b",
    runtime: "ollama",
    downloadGb: 65,
    minRamGb: 96,
    notes: "117B MoE, 5.1B active",
  },
  {
    label: "Mistral Small 4",
    ref: "hf.co/mistralai/Mistral-Small-4-119B-2603",
    runtime: "llama.cpp",
    downloadGb: 68,
    minRamGb: 96,
    notes: "119B MoE; not in Ollama's library; run a GGUF with llama-server --jinja",
  },
];

export const SUGGESTED_EMBEDDING_MODELS = [
  { label: "nomic-embed-text v1.5", ref: "ollama/nomic-embed-text:v1.5", dimensions: 768 },
  { label: "Qwen3-Embedding-0.6B", ref: "ollama/qwen3-embedding:0.6b", dimensions: 1024 },
] as const;

export const RAM_TIERS: RamTier[] = [
  { minRamGb: 16, guidance: "~9B class (Gemma 4 E-series / 12B, Qwen3.5 small)", models: [] },
  { minRamGb: 32, guidance: "27–31B (Qwen3.8-27B, Gemma 4 31B, GLM-4.7-Flash)", models: [] },
  { minRamGb: 96, guidance: "120B MoE (gpt-oss-120b, Mistral Small 4)", models: [] },
].map((tier, i, all) => ({
  ...tier,
  models: SUGGESTED_LOCAL_MODELS.filter(
    (m) =>
      m.minRamGb >= tier.minRamGb &&
      m.minRamGb < (all[i + 1]?.minRamGb ?? Number.POSITIVE_INFINITY),
  ),
}));

/** The guidance tier for a machine with `ramGb` of unified memory (below 16 GB: none). */
export function ramGuidance(ramGb: number): RamTier | undefined {
  return [...RAM_TIERS].reverse().find((t) => ramGb >= t.minRamGb);
}

/** Suggested models that fit in `ramGb`, largest first. */
export function modelsThatFit(ramGb: number): SuggestedModel[] {
  return SUGGESTED_LOCAL_MODELS.filter((m) => m.minRamGb <= ramGb).sort(
    (a, b) => b.minRamGb - a.minRamGb,
  );
}
