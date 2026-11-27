import { describe, expect, it } from "vitest";
import { chatModelRefs } from "../../src/shell/components/Overlays.tsx";

describe("model picker suggestions (models.list)", () => {
  it("lists chat models once, without embedding models", () => {
    expect(
      chatModelRefs({
        providers: [
          {
            models: [
              { ref: "lmstudio/qwen/qwen3.8-27b", capabilities: { embeddings: false } },
              { ref: "lmstudio/text-embedding-nomic", capabilities: { embeddings: true } },
              { ref: "anthropic/claude-sonnet-5-5" },
            ],
          },
          { models: [{ ref: "anthropic/claude-sonnet-5-5" }] },
        ],
      }),
    ).toEqual(["lmstudio/qwen/qwen3.8-27b", "anthropic/claude-sonnet-5-5"]);
  });

  it("suggests nothing when the Gateway has no models.list", () => {
    expect(chatModelRefs(undefined)).toEqual([]);
    expect(chatModelRefs({})).toEqual([]);
  });
});
