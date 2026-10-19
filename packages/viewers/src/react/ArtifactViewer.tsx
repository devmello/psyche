import { useState } from "react";
import { REACT_ARTIFACT_MIME } from "../core/react-artifact.ts";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import type { ViewerProps } from "./contract.ts";
import { ReactArtifactFrame } from "./ReactArtifactFrame.tsx";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

export interface ArtifactViewerProps extends ViewerProps {
  artifactHostUrl?: string;
  /** Self-hosted React bundler URL; React artifacts show a notice without it. */
  reactBundlerUrl?: string;
  /** Artifact version (update-by-name); a new version re-renders in place. */
  version?: number;
}

/**
 * An HTML or React artifact from the Library: title, version, Export, Open in pane, Save to
 * Library. React artifacts run through the self-hosted Sandpack bundler.
 */
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
                ...(item.mime === REACT_ARTIFACT_MIME
                  ? {
                      // Stays a runnable React artifact: one component, or the JSON file map.
                      name: withExtension(
                        item.name,
                        state.value.trimStart().startsWith("{") ? ".json" : ".tsx",
                      ),
                      mime: REACT_ARTIFACT_MIME,
                    }
                  : {
                      name: item.name.endsWith(".html") ? item.name : `${item.name}.html`,
                      mime: "text/html",
                    }),
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
      {item.mime === REACT_ARTIFACT_MIME ? (
        props.reactBundlerUrl === undefined ? (
          <ViewerMessage
            kind="unsupported"
            title="React artifacts need the Gateway's bundler"
            detail="Open this artifact in the Psyche app to run it."
          />
        ) : (
          <ReactArtifactFrame
            title={item.name}
            source={state.value}
            bundlerUrl={props.reactBundlerUrl}
            onOpenLink={(href) => props.onOpenInPane?.({ pane: "browser", target: href })}
            onError={setError}
          />
        )
      ) : (
        <ArtifactFrame
          title={item.name}
          html={state.value}
          {...(props.version === undefined ? {} : { version: props.version })}
          {...(props.artifactHostUrl === undefined ? {} : { hostUrl: props.artifactHostUrl })}
          onOpenLink={(href) => props.onOpenInPane?.({ pane: "browser", target: href })}
          onError={setError}
        />
      )}
    </div>
  );
}

const withExtension = (name: string, ext: string) => (name.endsWith(ext) ? name : `${name}${ext}`);
