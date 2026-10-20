import {
  PluginManifestSchema as ManifestSchema,
  type PluginManifestSchema,
  PsycheError,
} from "@psyche/protocol";
import { type SkillTree, safeRelPath, textOf } from "@psyche/skills";
import { Value } from "@sinclair/typebox/value";

/**
 * `psyche-plugin.json` (feature T4): name, version, description, `main` (an ES module inside the
 * folder) and the capabilities the plugin uses. A capability it does not declare is never
 * called, and its host refuses to register a handler for one.
 */
export const MANIFEST_FILE = "psyche-plugin.json";

export type PluginManifest = PluginManifestSchema;

export function parseManifest(tree: SkillTree): PluginManifest {
  const file = tree.get(MANIFEST_FILE);
  const text = file === undefined ? undefined : textOf(file);
  if (text === undefined) {
    throw new PsycheError("invalid_params", `the folder has no ${MANIFEST_FILE}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PsycheError("invalid_params", `${MANIFEST_FILE}: ${(err as Error).message}`);
  }
  if (!Value.Check(ManifestSchema, raw)) {
    const first = Value.Errors(ManifestSchema, raw).First();
    throw new PsycheError(
      "invalid_params",
      `${MANIFEST_FILE}: ${first === undefined ? "invalid" : `${first.path || "/"} ${first.message}`}`,
    );
  }
  const m = raw as PluginManifest;
  const main = safeRelPath(m.main);
  if (main === undefined || main !== m.main || !/\.m?js$/.test(main)) {
    throw new PsycheError(
      "invalid_params",
      `${MANIFEST_FILE}: main must be a .js or .mjs file inside the folder`,
    );
  }
  if (!tree.has(main))
    throw new PsycheError("invalid_params", `${MANIFEST_FILE}: ${main} is missing`);
  return { ...m, capabilities: [...new Set(m.capabilities)].sort() };
}
