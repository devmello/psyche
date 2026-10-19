import { extractText } from "../core/extract.ts";
import type { ViewerProps } from "./contract.ts";
import { useObjectUrl } from "./ImageViewer.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

type Slides =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "thumbnail"; bytes: Uint8Array }
  | { kind: "placeholder"; reason: string; slides: { ref: string; text: string }[] };

/**
 * Slides (P4). No JS renderer is trustworthy for PPTX (ADR-013): the configured
 * ConversionService turns the deck into a PDF (shown with the PDF viewer) or a Quick Look
 * thumbnail. Without one, or if conversion fails, a placeholder lists each slide's text.
 */
export function SlidesViewer(props: ViewerProps) {
  const { conversion, item } = props;
  const state = useLoadable(item.id, async (signal): Promise<Slides> => {
    const bytes = await props.load(signal);
    const input = { bytes, name: item.name, mime: item.mime };
    let reason = "No converter is configured for slides";
    if (conversion !== undefined) {
      for (const target of ["pdf", "thumbnail"] as const) {
        if (!conversion.supports(input, target)) continue;
        try {
          const out = await conversion.convert(input, target, { signal });
          return out.kind === "pdf"
            ? { kind: "pdf", bytes: out.bytes }
            : { kind: "thumbnail", bytes: out.bytes };
        } catch (err) {
          reason = `Conversion failed: ${(err as Error).message}`;
        }
      }
    }
    const text = await extractText({ bytes, name: item.name, mime: item.mime }).catch(
      () => undefined,
    );
    return {
      kind: "placeholder",
      reason,
      slides: (text?.refs ?? []).map((r) => ({
        ref: r.ref,
        text: (text?.text ?? "").slice(r.start, r.end).replace(/^\[slide \d+\]\n/, ""),
      })),
    };
  });
  const thumbUrl = useObjectUrl(
    state.status === "ready" && state.value.kind === "thumbnail" ? state.value.bytes : undefined,
    "image/png",
  );
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Preparing ${item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="These slides could not be opened"
        detail={state.error.message}
      />
    );
  const v = state.value;
  if (v.kind === "pdf") {
    const pdfBytes = v.bytes;
    return (
      <PdfViewer
        {...props}
        item={{ ...item, id: `${item.id}#pdf`, mime: "application/pdf" }}
        load={async () => pdfBytes}
      />
    );
  }
  if (v.kind === "thumbnail")
    return <img className="psy-slides__thumb" src={thumbUrl} alt={`${item.name}, first slide`} />;
  return (
    <div className="psy-slides psy-slides--placeholder">
      <ViewerMessage
        kind="unsupported"
        title="Slide preview unavailable"
        detail={`${v.reason}. Showing the text of each slide.`}
      />
      <ol aria-label="Slides">
        {v.slides.map((s) => (
          <li key={s.ref}>
            <pre>{s.text}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}
