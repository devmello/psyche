import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * SwiftShader, Chromium's software Vulkan (16 MB). Psyche needs macOS 15+, where every Mac renders
 * through Metal; without a usable GPU Chromium composites in software and keeps WebGL off, and it
 * no longer falls back to SwiftShader for WebGL unless `--enable-unsafe-swiftshader` is passed,
 * which Psyche never does. Measured on Electron 44 with the library removed: the same GPU feature
 * status, WebGL and WebGPU with the GPU, and a painted window with `--disable-gpu`
 * (docs/design/lightweight-2026.md). Removed before osx-sign seals the bundle.
 */
export const SWIFTSHADER_FILES = ["libvk_swiftshader.dylib", "vk_swiftshader_icd.json"] as const;

/** Removes SwiftShader from Electron Framework's Libraries; returns how many files went. */
export function pruneSwiftShader(contentsDir: string): number {
  const libs = join(
    contentsDir,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Libraries",
  );
  let removed = 0;
  for (const name of SWIFTSHADER_FILES) {
    const file = join(libs, name);
    if (!existsSync(file)) continue;
    rmSync(file);
    removed++;
  }
  return removed;
}
