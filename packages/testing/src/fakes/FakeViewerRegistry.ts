import type { Unsubscribe, ViewerRegistry, ViewerSpec } from "@psyche/protocol";

/** Reference viewer registry: exact MIME → `type/*` → extension, then higher priority. */
export class FakeViewerRegistry implements ViewerRegistry {
  #specs: ViewerSpec[] = [];

  register(spec: ViewerSpec): Unsubscribe {
    const copy = structuredClone(spec);
    this.#specs.push(copy);
    return () => {
      this.#specs = this.#specs.filter((s) => s !== copy);
    };
  }

  resolve(mime: string, name?: string): ViewerSpec | undefined {
    const m = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    const wildcard = `${m.split("/")[0] ?? ""}/*`;
    const ext = name?.toLowerCase().split(".").pop();
    const byPriority = (a: ViewerSpec, b: ViewerSpec) => (b.priority ?? 0) - (a.priority ?? 0);
    const pick = (pred: (s: ViewerSpec) => boolean) => this.#specs.filter(pred).sort(byPriority)[0];
    const found =
      pick((s) => s.mimeTypes.includes(m)) ??
      pick((s) => s.mimeTypes.includes(wildcard)) ??
      (ext === undefined || ext === name?.toLowerCase()
        ? undefined
        : pick((s) => s.extensions?.includes(ext) === true));
    return found === undefined ? undefined : structuredClone(found);
  }

  list(): ViewerSpec[] {
    return structuredClone(this.#specs);
  }
}
