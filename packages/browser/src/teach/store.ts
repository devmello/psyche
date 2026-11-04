import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserTeachStep,
  PsycheError,
  sanitizeTeachSteps,
  teachStepIssues,
  teachText,
} from "@psyche/protocol";

/**
 * Recordings the owner chose to keep (teach by showing, design doc §5). By default a recording is
 * never written anywhere: it lives in the desktop app's memory from Stop until the owner saves a
 * skill or discards it, and is then gone. Only "Keep this recording on this Mac" writes a file
 * here, and what it writes is the reviewed step list after `sanitizeTeachSteps`: no sensitive
 * value (there never was one), no typed example the owner did not choose to keep, no query
 * strings. The folder is `$PSYCHE_HOME/library/teach/` with mode 0700 and files 0600, the same as
 * the browser recordings beside it.
 *
 * Only the desktop app's main process opens this store. It has no tool, no Gateway method and no
 * bridge command, so the agent cannot list, read or write a kept recording.
 */
export interface KeptRecording {
  id: string;
  title: string;
  /** Epoch ms. */
  keptAt: number;
  steps: BrowserTeachStep[];
}

export const KEPT_RECORDING_LIMIT = 20;
const ID = /^teach_[a-z0-9]{8,32}$/;

export class TeachKeptStore {
  readonly dir: string;
  #now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.#now = now;
  }

  #file(id: string): string {
    if (!ID.test(id)) throw new PsycheError("invalid_params", "not a recording id");
    return join(this.dir, `${id}.json`);
  }

  async keep(
    id: string,
    title: string,
    steps: readonly BrowserTeachStep[],
  ): Promise<KeptRecording> {
    const file = this.#file(id);
    const clean = sanitizeTeachSteps(steps);
    const issues = teachStepIssues(clean);
    if (issues.length > 0) throw new PsycheError("invalid_params", issues.join("; "));
    const existing = await this.list();
    if (existing.length >= KEPT_RECORDING_LIMIT && !existing.some((r) => r.id === id))
      throw new PsycheError("conflict", `at most ${KEPT_RECORDING_LIMIT} kept recordings`);
    const rec: KeptRecording = {
      id,
      title: teachText(title, 120),
      keptAt: this.#now(),
      steps: clean,
    };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    return rec;
  }

  async get(id: string): Promise<KeptRecording | undefined> {
    try {
      const rec = JSON.parse(await readFile(this.#file(id), "utf8")) as KeptRecording;
      // Re-clean on the way out: a file edited by hand never carries a value past the rules.
      return { ...rec, steps: sanitizeTeachSteps(rec.steps) };
    } catch (err) {
      if (err instanceof PsycheError) throw err;
      return undefined;
    }
  }

  async list(): Promise<KeptRecording[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: KeptRecording[] = [];
    for (const n of names) {
      const id = n.replace(/\.json$/, "");
      if (!n.endsWith(".json") || !ID.test(id)) continue;
      const rec = await this.get(id);
      if (rec !== undefined) out.push(rec);
    }
    return out.sort((a, b) => b.keptAt - a.keptAt);
  }

  async delete(id: string): Promise<void> {
    await rm(this.#file(id), { force: true });
  }
}
