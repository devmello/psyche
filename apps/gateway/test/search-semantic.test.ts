import { AiSdkAdapter, type ModelRouter } from "@psyche/model-router";
import { createSearchIndex, fakeEmbedder, SemanticIndex } from "@psyche/search";
import { describe, expect, it } from "vitest";
import {
  routerEmbedder,
  SemanticController,
  type SemanticEngines,
  semanticConfig,
} from "../src/compose/search-semantic.ts";

/**
 * S4 (docs/design/search-2026.md §3): an embedding role bound to a cloud provider is used only
 * with `search.semantic.allowCloud`. No network: the router's `embed` is a stub.
 */

function fakeRouter(binding: string | undefined, calls: unknown[] = []): ModelRouter {
  const providers = [
    new AiSdkAdapter({ id: "ollama", kind: "ollama" }),
    new AiSdkAdapter({ id: "openai", kind: "openai" }),
  ];
  return {
    role: (role: string) =>
      role === "embedding" && binding !== undefined ? { model: binding } : undefined,
    providers: () => providers,
    embed: async (texts: string[], options: unknown) => {
      calls.push({ texts, options });
      return texts.map(() => [1, 0, 0]);
    },
  } as unknown as ModelRouter;
}

describe("routerEmbedder", () => {
  it("uses a local embedding role and refuses a cloud one without allowCloud", async () => {
    expect(routerEmbedder(undefined, false)).toEqual({ blocked: "no_embedding_model" });
    expect(routerEmbedder(fakeRouter(undefined), true)).toEqual({ blocked: "no_embedding_model" });

    const calls: unknown[] = [];
    const local = routerEmbedder(fakeRouter("ollama/nomic-embed-text", calls), false);
    expect("embedder" in local && local.cloud).toBe(false);
    if (!("embedder" in local)) throw new Error("expected an embedder");
    expect(local.embedder.model).toBe("router/ollama/nomic-embed-text");
    await local.embedder.embed(["hello"], "query");
    expect(calls).toEqual([{ texts: ["hello"], options: { task: "query" } }]);

    const cloudRouter = fakeRouter("openai/text-embedding-3-small");
    expect(routerEmbedder(cloudRouter, false)).toEqual({ blocked: "cloud_not_allowed" });
    const cloud = routerEmbedder(cloudRouter, true);
    expect("embedder" in cloud && cloud.cloud).toBe(true);
  });
});

describe("SemanticController with allowCloud", () => {
  it("re-applies when allowCloud changes and reports that text leaves the machine", async () => {
    const index = createSearchIndex();
    const semantic = new SemanticIndex(index.db, { sleep: async () => undefined });
    const asked: boolean[] = [];
    const engines: SemanticEngines = {
      builtin: async () => fakeEmbedder(),
      router: (allowCloud) => {
        asked.push(allowCloud);
        return allowCloud
          ? { embedder: fakeEmbedder([], { model: "router/openai/x" }), cloud: true }
          : { blocked: "cloud_not_allowed" };
      },
    };
    const controller = new SemanticController(semantic, engines, () => undefined);
    const settings: Record<string, unknown> = {
      "search.semantic.enabled": true,
      "search.semantic.engine": "router",
    };
    const apply = () => controller.apply(semanticConfig((k) => settings[k]));
    await apply();
    expect(controller.status()).toMatchObject({ state: "blocked", blocked: "cloud_not_allowed" });
    expect(semantic.model).toBeUndefined();

    settings["search.semantic.allowCloud"] = true;
    await apply();
    await semantic.idle();
    expect(asked).toEqual([false, true]);
    expect(controller.status()).toMatchObject({ cloud: true, model: "router/openai/x" });
    expect(semantic.model).toBe("router/openai/x");

    // Back off: refused again, and the cloud embedder is no longer used.
    settings["search.semantic.allowCloud"] = false;
    await apply();
    expect(controller.status()).toMatchObject({ state: "blocked" });
    expect(semantic.model).toBeUndefined();
  });
});
