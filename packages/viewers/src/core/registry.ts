import type { Unsubscribe, ViewerRegistry, ViewerRenderKind, ViewerSpec } from "@psyche/protocol";

/** Normalises `Type/Sub; charset=x` to `type/sub`. */
export function normalizeMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Lower-case extension without the dot, or undefined when the name has none. */
export function extensionOf(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1);
}

/**
 * The viewer registry (architecture §5, protocol `ViewerRegistry`). Resolution order: exact MIME →
 * `type/*` wildcard → extension; within a step the higher `priority` wins, then the earlier
 * registration. Specs are copied in and out so callers cannot mutate the registry.
 */
export class DefaultViewerRegistry implements ViewerRegistry {
  #specs: ViewerSpec[] = [];

  constructor(specs: readonly ViewerSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: ViewerSpec): Unsubscribe {
    if (spec.id.length === 0) throw new TypeError("ViewerSpec.id must not be empty");
    const copy: ViewerSpec = structuredClone({
      ...spec,
      mimeTypes: spec.mimeTypes.map(normalizeMime),
      ...(spec.extensions === undefined
        ? {}
        : { extensions: spec.extensions.map((e) => e.toLowerCase().replace(/^\./, "")) }),
    });
    this.#specs.push(copy);
    return () => {
      this.#specs = this.#specs.filter((s) => s !== copy);
    };
  }

  resolve(mime: string, name?: string): ViewerSpec | undefined {
    const m = normalizeMime(mime);
    const wildcard = `${m.split("/")[0] ?? ""}/*`;
    const ext = extensionOf(name);
    const found =
      this.#pick((s) => m.length > 0 && s.mimeTypes.includes(m)) ??
      this.#pick((s) => m.length > 0 && s.mimeTypes.includes(wildcard)) ??
      (ext === undefined ? undefined : this.#pick((s) => s.extensions?.includes(ext) === true));
    return found === undefined ? undefined : structuredClone(found);
  }

  list(): ViewerSpec[] {
    return structuredClone(this.#specs);
  }

  #pick(pred: (s: ViewerSpec) => boolean): ViewerSpec | undefined {
    let best: ViewerSpec | undefined;
    for (const s of this.#specs) {
      if (!pred(s)) continue;
      if (best === undefined || (s.priority ?? 0) > (best.priority ?? 0)) best = s;
    }
    return best;
  }
}

const spec = (
  id: string,
  render: ViewerRenderKind,
  mimeTypes: string[],
  extensions: string[],
  extra: Partial<ViewerSpec> = {},
): ViewerSpec => ({ id, label: extra.label ?? id, render, mimeTypes, extensions, canEdit: false, ...extra });

/** Code extensions handled by the code viewer (Shiki language ids are mapped in `core/code`). */
export const CODE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
  "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "sql", "css", "scss", "html", "xml",
  "yaml", "yml", "toml", "ini", "lua", "r", "dockerfile", "makefile", "diff", "patch", "graphql",
  "vue", "svelte",
];

/** The built-in viewers, in docs/06 §3.7 order. */
export const DEFAULT_VIEWER_SPECS: readonly ViewerSpec[] = [
  spec("pdf", "pdf", ["application/pdf"], ["pdf"], { label: "PDF" }),
  spec(
    "sheet",
    "sheet",
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.oasis.opendocument.spreadsheet",
      "text/csv",
      "text/tab-separated-values",
    ],
    ["xlsx", "xlsm", "xls", "ods", "csv", "tsv"],
    { label: "Spreadsheet" },
  ),
  spec(
    "docx",
    "document",
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["docx"],
    { label: "Word document" },
  ),
  spec(
    "slides",
    "slides",
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.presentation",
      "application/vnd.apple.keynote",
    ],
    ["pptx", "ppt", "odp", "key"],
    { label: "Slides" },
  ),
  spec("image", "image", ["image/*"], ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic"], {
    label: "Image",
  }),
  spec("media", "media", ["audio/*", "video/*"], ["mp3", "m4a", "wav", "ogg", "mp4", "mov", "webm"], {
    label: "Media",
  }),
  spec("json", "json", ["application/json", "application/ld+json"], ["json", "jsonl", "geojson"], {
    label: "JSON",
  }),
  spec("markdown", "markdown", ["text/markdown", "text/x-markdown"], ["md", "markdown", "mdx"], {
    label: "Markdown",
    canEdit: true,
  }),
  spec("email", "email", ["message/rfc822"], ["eml"], { label: "Email" }),
  spec("artifact", "artifact", ["application/vnd.psyche.artifact+html"], [], {
    label: "Artifact",
    priority: 10,
  }),
  spec(
    "code",
    "code",
    [
      "text/javascript",
      "application/javascript",
      "text/typescript",
      "application/typescript",
      "text/x-python",
      "text/css",
      "text/html",
      "application/xml",
      "text/xml",
      "application/x-sh",
      "application/yaml",
      "text/yaml",
      "application/toml",
    ],
    CODE_EXTENSIONS,
    { label: "Code", canEdit: true },
  ),
  spec("text", "text", ["text/*"], ["txt", "log", "text"], { label: "Text", canEdit: true, priority: -1 }),
];

/** A registry pre-loaded with the built-in viewers. */
export function createDefaultViewerRegistry(): DefaultViewerRegistry {
  return new DefaultViewerRegistry(DEFAULT_VIEWER_SPECS);
}
