import { type ArtifactRenderProps, CanvasPane, UiSlotsProvider, useLibraryItem } from "@psyche/ui";
import { ViewerHost } from "@psyche/viewers";
import { mimeFromName } from "@psyche/viewers/core/detect";
import { type ReactElement, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { ConnectedFileViewer } from "./viewers.tsx";

/**
 * The canvas pane in the composed app (docs/design/chat-experience-2026.md §4.2): the kit's
 * `CanvasPane`, with `@psyche/viewers` drawing what the kit draws plainly (code in CodeMirror
 * with highlighting, images at full size). Docs and tables stay the kit's: the Markdown editor
 * already comes from the viewers through `renderEditor`, and tables need cell-level ops.
 */

/** File extensions the code viewer recognises, by the artifact's language id. */
const CODE_EXT: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  shell: "sh",
  bash: "sh",
  markdown: "md",
};

function CodeBody({ props }: { props: ArtifactRenderProps }): ReactElement {
  const { artifact, content } = props;
  const lang = artifact.language ?? "txt";
  const name = `${artifact.nameSlug}.${CODE_EXT[lang] ?? lang}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the version shown
  const load = useCallback(
    async () => new TextEncoder().encode(content.content),
    [artifact.id, content.version],
  );
  return (
    <ViewerHost
      key={`${artifact.id}@${content.version}`}
      item={{
        id: `${artifact.id}@${content.version}`,
        name,
        mime: mimeFromName(name) ?? "text/plain",
        provenance: artifact.untrusted === true ? "untrusted" : "trusted",
      }}
      load={load}
      compact
    />
  );
}

function ImageBody({ itemId }: { itemId: string }): ReactElement | null {
  const { item } = useLibraryItem(itemId);
  if (item === null) return null;
  return (
    <ConnectedFileViewer
      file={{
        libraryPath: item.path,
        name: item.name,
        size: item.size,
        modifiedAt: null,
        libraryItem: item,
      }}
      compact
    />
  );
}

/**
 * Mermaid text drawn in strict mode (docs/design/chat-experience-2026.md §4.6): Mermaid's own
 * sanitizer runs with `securityLevel: "strict"` (no click handlers, no HTML labels), and the SVG
 * it returns is shown as an image from a data URL, so nothing in it can run or reach the page.
 * Mermaid loads on first use. A diagram that fails to parse shows its source instead.
 */
function DiagramBody({ source }: { source: string }): ReactElement {
  const id = `mmd-${useId().replace(/\W/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false });
        const out = await mermaid.render(id, source);
        if (live) setSvg(out.svg);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [source, id]);
  if (failed)
    return (
      <pre className="overflow-x-auto font-mono text-mono text-label-primary">
        <code>{source}</code>
      </pre>
    );
  if (svg === null) return <p className="text-callout text-label-secondary">…</p>;
  return (
    <img
      alt=""
      className="max-w-full"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
    />
  );
}

export function renderArtifact(props: ArtifactRenderProps): ReactNode {
  if (props.artifact.type === "diagram" && !props.editing)
    return <DiagramBody source={props.content.content} />;
  if (props.artifact.type === "code" && !props.editing) return <CodeBody props={props} />;
  if (props.artifact.type === "image") return <ImageBody itemId={props.content.content} />;
  return undefined;
}

const CANVAS_SLOTS = { renderArtifact };

export function ComposedCanvas({
  artifactId,
  threadId,
  onOpen,
}: {
  artifactId: string;
  threadId: string;
  onOpen: (artifactId: string, title: string) => void;
}): ReactElement {
  return (
    <UiSlotsProvider value={CANVAS_SLOTS}>
      <CanvasPane
        artifactId={artifactId}
        threadId={threadId}
        onSelect={(a) => onOpen(a.id, a.title)}
      />
    </UiSlotsProvider>
  );
}
