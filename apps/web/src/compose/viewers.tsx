/// <reference path="../vite-env.d.ts" />
import {
  convertFileBytes,
  type EditorSlotProps,
  type FileRef,
  type FileSource,
  FilesPane,
  type GatewayCall,
  readFileBytes,
  t,
  useCall,
} from "@psyche/ui";
import {
  ControlledMarkdownEditor,
  configurePdfJs,
  ViewerHost,
  type ViewerItem,
} from "@psyche/viewers";
import { type ConversionService, ConversionUnavailableError } from "@psyche/viewers/core/convert";
import { mimeFromName } from "@psyche/viewers/core/detect";
import "@psyche/viewers/styles.css";
import "./viewers.css";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ReactElement, useCallback, useMemo } from "react";

/**
 * The viewers in the composed app (feature P4; UI design §3.7): `@psyche/viewers` rendering a
 * file the Gateway reads in chunks (`files.read`), with Office conversion through the Gateway's
 * sandboxed LibreOffice (`documents.convert`). PDF.js runs its self-hosted worker.
 */

configurePdfJs({ workerSrc });

/** Extensions LibreOffice converts for the viewers (slides first; documents and sheets too). */
const CONVERTIBLE = /\.(pptx?|odp|key|docx?|odt|rtf|xlsx?|ods)$/i;

/** Plain words for why conversion can't run, shown in the slides placeholder. */
export function conversionUnavailableMessage(err: unknown): string | null {
  const code = (err as { code?: unknown }).code;
  const reason = (err as { details?: { reason?: unknown } }).details?.reason;
  if (code === "unavailable" && reason === "sandbox_unavailable") {
    return t("web.viewers.noSandbox");
  }
  if (code === "unavailable" || code === "not_implemented") {
    return t("web.viewers.needsFullImage");
  }
  return null;
}

/** A `ConversionService` that converts one file through the Gateway. */
export function gatewayConversion(call: GatewayCall, source: FileSource): ConversionService {
  return {
    id: "gateway-libreoffice",
    supports: (input) => CONVERTIBLE.test(input.name),
    async convert(_input, target, opts) {
      try {
        const r = await convertFileBytes(
          call,
          source,
          target,
          opts?.signal ? { signal: opts.signal } : {},
        );
        return target === "pdf"
          ? { kind: "pdf", bytes: r.bytes }
          : { kind: "thumbnail", mime: "image/png", bytes: r.bytes };
      } catch (err) {
        const unavailable = conversionUnavailableMessage(err);
        if (unavailable !== null) throw new ConversionUnavailableError(unavailable);
        throw err;
      }
    },
  };
}

export function sourceOf(file: FileRef): FileSource | null {
  if (file.path !== undefined) return { path: file.path };
  if (file.libraryPath !== undefined) return { libraryPath: file.libraryPath };
  return null;
}

/** What a viewer is told about the file. Only files the agent made count as trusted. */
export function viewerItemOf(file: FileRef): ViewerItem {
  return {
    id: file.path ?? `library:${file.libraryPath ?? file.name}`,
    name: file.name,
    mime: file.libraryItem?.mime ?? mimeFromName(file.name) ?? "application/octet-stream",
    ...(file.size === null ? {} : { size: file.size }),
    provenance: file.libraryItem?.origin === "agent" ? "trusted" : "untrusted",
    ...(file.libraryItem ? { libraryItem: file.libraryItem } : {}),
  };
}

export function FileViewer({
  file,
  call,
  compact = false,
}: {
  file: FileRef;
  call: GatewayCall;
  compact?: boolean;
}): ReactElement {
  const source = sourceOf(file);
  const key = source === null ? "" : JSON.stringify(source);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the source's identity
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (source === null) throw new Error(t("web.viewers.noPath"));
      return (await readFileBytes(call, source, { signal })).bytes;
    },
    [call, key],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the source's identity
  const conversion = useMemo(
    () => (source === null ? undefined : gatewayConversion(call, source)),
    [call, key],
  );
  return (
    <ViewerHost
      item={viewerItemOf(file)}
      load={load}
      compact={compact}
      {...(conversion ? { conversion } : {})}
    />
  );
}

/** The viewer with the kit store's Gateway connection. */
export function ConnectedFileViewer({
  file,
  compact,
}: {
  file: FileRef;
  compact?: boolean;
}): ReactElement {
  const call = useCall() as GatewayCall;
  return <FileViewer file={file} call={call} {...(compact === undefined ? {} : { compact })} />;
}

/** The Files pane (§3.7) for the shell's pane slot: the kit's tree with these viewers. */
export function ComposedFilesPane({
  target,
  navigate,
}: {
  target: string | null;
  navigate: (to: string) => void;
}): ReactElement {
  return (
    <FilesPane
      target={target}
      renderViewer={(file) => <ConnectedFileViewer key={sourceKey(file)} file={file} />}
      onShareFolder={() => navigate("/settings/files")}
    />
  );
}

const sourceKey = (file: FileRef) => file.path ?? `library:${file.libraryPath ?? file.name}`;

/**
 * The kit's `renderEditor` slot: the viewers' Rich / Source / Diff Markdown editor as a controlled
 * field (Soul & Memory keeps the draft, budget, Save and Discard), with the teaching loop's margin
 * marks beside lesson-owned lines.
 */
export function renderMarkdownEditor(props: EditorSlotProps): ReactElement {
  return (
    <ControlledMarkdownEditor
      key={props.path}
      path={props.path}
      value={props.value}
      onChange={props.onChange}
      {...(props.readOnly ? { readOnly: true } : {})}
      {...(props.marks ? { marks: props.marks } : {})}
      {...(props.onMarkActivate ? { onMarkActivate: props.onMarkActivate } : {})}
      modesLabel={t("agent.memory.modes")}
      modeLabels={{
        rich: t("agent.memory.mode.rich"),
        source: t("agent.memory.mode.source"),
        diff: t("agent.memory.mode.diff"),
      }}
    />
  );
}
