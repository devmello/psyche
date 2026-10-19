import type { ViewerRegistry, ViewerRenderKind } from "@psyche/protocol";
import {
  type ComponentType,
  lazy,
  Component as ReactComponent,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from "react";
import { createDefaultViewerRegistry } from "../core/registry.ts";
import type { ViewerComponentMap, ViewerProps } from "./contract.ts";
import { ViewerMessage } from "./states.tsx";

type Extra = { artifactHostUrl?: string };

// Each viewer is its own chunk: opening a CSV never downloads PDF.js or CodeMirror.
const lazyNamed = <K extends string>(
  load: () => Promise<Record<K, ComponentType<ViewerProps & Extra>>>,
  name: K,
) => lazy(async () => ({ default: (await load())[name] }));

/** The built-in render kind → component map (overridable per kind through `components`). */
export const DEFAULT_VIEWER_COMPONENTS: Record<
  ViewerRenderKind,
  ComponentType<ViewerProps & Extra>
> = {
  pdf: lazyNamed(() => import("./PdfViewer.tsx"), "PdfViewer"),
  sheet: lazyNamed(() => import("./SheetViewer.tsx"), "SheetViewer"),
  document: lazyNamed(() => import("./DocumentViewer.tsx"), "DocumentViewer"),
  slides: lazyNamed(() => import("./SlidesViewer.tsx"), "SlidesViewer"),
  image: lazyNamed(() => import("./ImageViewer.tsx"), "ImageViewer"),
  media: lazyNamed(() => import("./ImageViewer.tsx"), "MediaViewer"),
  code: lazyNamed(() => import("./CodeViewer.tsx"), "CodeViewer"),
  text: lazyNamed(() => import("./CodeViewer.tsx"), "CodeViewer"),
  markdown: lazyNamed(() => import("./CodeViewer.tsx"), "CodeViewer"),
  json: lazyNamed(() => import("./JsonViewer.tsx"), "JsonViewer"),
  email: lazyNamed(() => import("./EmailViewer.tsx"), "EmailViewer"),
  artifact: lazyNamed(() => import("./ArtifactViewer.tsx"), "ArtifactViewer"),
};

export interface ViewerHostProps extends ViewerProps {
  registry?: ViewerRegistry;
  components?: ViewerComponentMap;
  /** Gateway artifact host page URL (hosted sandbox placement). */
  artifactHostUrl?: string;
  /** "Trust this file" on a quarantined download (docs/06 §3.12). */
  onTrust?: () => void;
}

/** Any viewer crash (bad file, parser bug) becomes an error state, never a blank pane. */
export class ViewerErrorBoundary extends ReactComponent<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error !== null) {
      return (
        <ViewerMessage
          kind="error"
          title={`${this.props.name} could not be shown`}
          detail={this.state.error.message}
        />
      );
    }
    return this.props.children;
  }
}

let fallbackRegistry: ViewerRegistry | undefined;
function defaultRegistry(): ViewerRegistry {
  fallbackRegistry ??= createDefaultViewerRegistry();
  return fallbackRegistry;
}

/**
 * Picks the viewer for an item from the registry and renders it. Quarantined downloads need a
 * click before any viewer parses them.
 */
export function ViewerHost(props: ViewerHostProps) {
  const { registry, components, onTrust, ...viewer } = props;
  const reg = registry ?? defaultRegistry();
  const spec = useMemo(
    () => reg.resolve(props.item.mime, props.item.name),
    [reg, props.item.mime, props.item.name],
  );
  // Keyed by item: opening one quarantined file never opens the next one.
  const [openedId, setOpenedId] = useState<string | null>(null);
  const opened = openedId === props.item.id;
  if (spec === undefined) {
    return (
      <ViewerMessage
        kind="unsupported"
        title="No preview for this file type"
        detail={props.item.name}
        action={
          props.onSaveToLibrary === undefined && props.onSendToChat ? (
            <button
              type="button"
              onClick={() => props.onSendToChat?.({ itemId: props.item.id, name: props.item.name })}
            >
              Send to chat
            </button>
          ) : undefined
        }
      />
    );
  }
  if (props.item.libraryItem?.quarantined === true && !opened) {
    return (
      <ViewerMessage
        kind="unsupported"
        title="Downloaded file"
        detail={`${props.item.name} came from the web and has not been opened yet.`}
        action={
          <span>
            <button type="button" onClick={() => setOpenedId(props.item.id)}>
              Open
            </button>
            {onTrust ? (
              <button type="button" onClick={onTrust}>
                Trust this file
              </button>
            ) : null}
          </span>
        }
      />
    );
  }
  const Component = components?.[spec.render] ?? DEFAULT_VIEWER_COMPONENTS[spec.render];
  return (
    <ViewerErrorBoundary key={props.item.id} name={props.item.name}>
      <Suspense fallback={<ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />}>
        <div className="psy-viewer" data-viewer={spec.id} data-provenance={props.item.provenance}>
          <Component {...viewer} />
        </div>
      </Suspense>
    </ViewerErrorBoundary>
  );
}
