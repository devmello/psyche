import { useState } from "react";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

export interface ArtifactViewerProps extends ViewerProps {
  artifactHostUrl?: string;
  /** Artifact version (update-by-name); a new version re-renders in place. */
  version?: number;
}

/** An HTML artifact from the Library: title, version, Export, Open in pane, Save to Library. */
export function ArtifactViewer(props: ArtifactViewerProps) {
  const { item } = props;
  const state = useLoadable(`${item.id}@${props.version ?? item.etag ?? ""}`, async (signal) =>
    new TextDecoder().decode(await props.load(signal)),
  );
  const [error, setError] = useState<string | null>(null);
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This artifact could not be opened"
        detail={state.error.message}
      />
    );
  return (
    <div className="psy-artifact-viewer">
      <Toolbar label="Artifact">
        <span>{item.name}</span>
        {props.version === undefined ? null : <small>v{props.version}</small>}
        {props.onOpenInPane ? (
          <button
            type="button"
            onClick={() => props.onOpenInPane?.({ pane: "artifact", target: item.id })}
          >
            Open in pane
          </button>
        ) : null}
        {props.onSaveToLibrary ? (
          <button
            type="button"
            onClick={() =>
              props.onSaveToLibrary?.({
                name: item.name.endsWith(".html") ? item.name : `${item.name}.html`,
                mime: "text/html",
                bytes: new TextEncoder().encode(state.value),
              })
            }
          >
            Export
          </button>
        ) : null}
      </Toolbar>
      {error === null ? null : (
        <p role="status" className="psy-artifact-viewer__error">
          Script error in artifact: {error}
        </p>
      )}
      <ArtifactFrame
        title={item.name}
        html={state.value}
        {...(props.version === undefined ? {} : { version: props.version })}
        {...(props.artifactHostUrl === undefined ? {} : { hostUrl: props.artifactHostUrl })}
        onOpenLink={(href) => props.onOpenInPane?.({ pane: "browser", target: href })}
        onError={setError}
      />
    </div>
  );
}
