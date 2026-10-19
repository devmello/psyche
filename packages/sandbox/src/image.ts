import { fileURLToPath } from "node:url";
import versions from "../../../deploy/sandbox-image/versions.json" with { type: "json" };
import { buildArgs, type ContainerBackendKind } from "./backends.ts";
import { type CliDriver, nodeCliDriver, runCli } from "./cli.ts";

export type ImageVariant = "core" | "base" | "full";

export const IMAGE_ENV = "PSYCHE_SANDBOX_IMAGE";

/** Directory holding the Dockerfile (`deploy/sandbox-image`). */
export const IMAGE_CONTEXT_DIR = fileURLToPath(
  new URL("../../../deploy/sandbox-image/", import.meta.url),
);

export const imageVersions = versions;

/** Tag used for images built locally from this checkout. */
export function localImageTag(variant: ImageVariant): string {
  return `psyche-sandbox:${variant}-dev`;
}

/**
 * The image to run: explicit option, then `PSYCHE_SANDBOX_IMAGE`, then the published,
 * digest-pinned reference from versions.json, then the local dev tag (`pnpm sandbox:build`).
 */
export function resolveImage(
  variant: ImageVariant,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): { image: string; pinned: boolean } {
  if (explicit !== undefined && explicit !== "") return { image: explicit, pinned: false };
  const fromEnv = env[IMAGE_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return { image: fromEnv, pinned: false };
  const digest: string | null = versions.variants[variant].digest;
  if (digest !== null) return { image: `${versions.repository}@${digest}`, pinned: true };
  return { image: localImageTag(variant), pinned: false };
}

/** Builds a Dockerfile target with the backend's own builder (Apple uses `container build`). */
export async function buildImage(
  backend: { kind: ContainerBackendKind; cli: string },
  variant: ImageVariant,
  options: { tag?: string; driver?: CliDriver; timeoutMs?: number } = {},
): Promise<{ tag: string; durationMs: number }> {
  const tag = options.tag ?? localImageTag(variant);
  const r = await runCli(
    options.driver ?? nodeCliDriver,
    backend.cli,
    buildArgs(backend.kind, IMAGE_CONTEXT_DIR, tag, variant),
    { timeoutMs: options.timeoutMs ?? 30 * 60_000, maxBytes: 256 * 1024 },
  );
  if (r.exitCode !== 0) {
    const tail = r.stderr.toString("utf8").slice(-4000);
    throw new Error(`image build failed (${backend.kind}, ${variant}): ${tail}`);
  }
  return { tag, durationMs: r.durationMs };
}
