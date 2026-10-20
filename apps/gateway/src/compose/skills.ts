import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PsycheError, type SkillLoader } from "@psyche/protocol";
import {
  createSkillLoader,
  createSkillsHandlers,
  createSkillTools,
  defaultGateContext,
  deniedToolsFromPolicy,
  type FsSkillLoader,
  SqliteSkillStateStore,
} from "@psyche/skills";
import type { HandlerDef } from "../context.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Skills (features T1, T2; security §11; owner S16, `@psyche/skills`). Discovery
 * `$PSYCHE_HOME/workspace/skills` → `$PSYCHE_HOME/skills` (installed, `skills.lock.json`) →
 * the bundled `skills/` folder. Installing is a proposal: `skills.proposeInstall` fetches,
 * scans and checks the manifest against the owner's policy, then opens a device-only, `once`
 * `skill_install` card (announced through the executor broker); only `skills.install` with that
 * approval writes files. The agent sees approved, enabled skills only: the loop's skills index,
 * `skills_search` and `skills_read` all read the same loader.
 */

export interface SkillsOptions {
  /** Bundled skills folder; `null` for none. Default `PSYCHE_BUNDLED_SKILLS` or the repo's `skills/`. */
  bundledDir?: string | null;
  /** Watch the folders for hot reload (default true). */
  watch?: boolean;
}

export interface ComposedSkills {
  /** The part factory for `composeGateway`'s parts list. */
  part: (services: ComposeServices) => ComposedPart;
  /** For the agent loop; usable once the part has been composed. */
  loader: SkillLoader;
}

const REPO_SKILLS = fileURLToPath(new URL("../../../../skills/", import.meta.url));

function bundledDirFor(opts: SkillsOptions): string | undefined {
  if (opts.bundledDir === null) return undefined;
  const dir = opts.bundledDir ?? process.env.PSYCHE_BUNDLED_SKILLS ?? REPO_SKILLS;
  return existsSync(dir) ? dir : undefined;
}

export function composeSkills(opts: SkillsOptions = {}): ComposedSkills {
  let real: FsSkillLoader | undefined;
  const ready = (): FsSkillLoader => {
    if (real === undefined) throw new PsycheError("unavailable", "skills are not composed yet");
    return real;
  };
  // The loop is created after the parts; it reads skills through this delegate.
  const loader: SkillLoader = {
    list: () => ready().list(),
    load: (name) => ready().load(name),
    search: (query, limit) => ready().search(query, limit),
    proposeInstall: (source) => ready().proposeInstall(source),
    install: (proposalId, approvalId) => ready().install(proposalId, approvalId),
    remove: (name) => ready().remove(name),
    promptIndex: (options) => ready().promptIndex(options),
    commands: () => ready().commands(),
    setEnabled: (name, enabled, source) => ready().setEnabled(name, enabled, source),
    checkUpdates: (name) => ready().checkUpdates(name),
  };

  const part = (services: ComposeServices): ComposedPart => {
    const { home, publish, tools, rawBroker } = services;
    const bundledDir = bundledDirFor(opts);
    const fs = createSkillLoader({
      workspaceDir: join(home, "workspace", "skills"),
      homeDir: join(home, "skills"),
      ...(bundledDir === undefined ? {} : { bundledDir }),
      state: new SqliteSkillStateStore(services.db.sqlite),
      broker: services.broker,
      // `requires.tools` gates on what the agent can actually call right now.
      gate: () => defaultGateContext(tools.list().map((t) => t.name)),
      // The owner's tool-only deny rules: a skill may not even declare a denied tool.
      installPolicy: () => ({ deniedTools: deniedToolsFromPolicy(rawBroker.policy) }),
      onChange: (event) => publish("skills.changed", event),
    });
    real = fs;
    const unregister = createSkillTools(fs).map((t) => tools.register(t));
    const handlers: Record<string, HandlerDef> = {};
    const table = createSkillsHandlers(fs, {
      broker: services.broker,
      surfaces: ["desktop", "web"],
      onUpdate: (update) => publish("skills.updated", update),
    });
    for (const [name, fn] of Object.entries(table)) {
      handlers[name] = { run: (_call, params) => (fn as (p: unknown) => unknown)(params ?? {}) };
    }
    let unwatch: (() => void) | undefined;
    return {
      handlers,
      start() {
        if (opts.watch !== false) unwatch = fs.watch();
      },
      stop() {
        unwatch?.();
        fs.close();
        for (const u of unregister) u();
      },
    };
  };
  return { part, loader };
}
