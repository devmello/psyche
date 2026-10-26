import type { Extension } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";

/**
 * Margin marks on lines (teaching loop §5.2: "Learned from you · 25 Oct" beside lesson-owned
 * lines). A mark names a line by its text, so it follows the line as the owner edits around it
 * and disappears when the line itself is changed. CodeMirror hides its gutters from assistive
 * tech (`aria-hidden`), so a mark is a pointer-only cue with a tooltip: the host must also list
 * the marked lines with named, keyboard-reachable controls (Soul & Memory does, above the editor).
 */
export interface LineMark {
  id: string;
  /** The line's text; compared trimmed. */
  text: string;
  /** The tooltip ("Learned from you on 25 October. Show details"). */
  label: string;
}

export interface LineMarksConfig {
  marks: readonly LineMark[];
  onActivate?: ((id: string) => void) | undefined;
}

class MarkButton extends GutterMarker {
  readonly mark: LineMark;
  readonly onActivate: ((id: string) => void) | undefined;

  constructor(mark: LineMark, onActivate: ((id: string) => void) | undefined) {
    super();
    this.mark = mark;
    this.onActivate = onActivate;
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof MarkButton &&
      other.mark.id === this.mark.id &&
      other.mark.label === this.mark.label &&
      other.onActivate === this.onActivate
    );
  }

  override toDOM(): Node {
    // Not focusable: the gutter is aria-hidden, and focus must never land in hidden content.
    const dot = document.createElement("span");
    dot.className = "psy-md-mark";
    dot.title = this.mark.label;
    dot.dataset.markId = this.mark.id;
    dot.addEventListener("click", () => this.onActivate?.(this.mark.id));
    return dot;
  }
}

/** The marks gutter. Reconfigure it (a compartment) when the marks change. */
export function lineMarks(config: LineMarksConfig): Extension {
  const byText = new Map(
    config.marks.filter((m) => m.text.trim() !== "").map((m) => [m.text.trim(), m] as const),
  );
  return gutter({
    class: "psy-md-marks",
    lineMarker(view, line) {
      const mark = byText.get(view.state.doc.lineAt(line.from).text.trim());
      return mark === undefined ? null : new MarkButton(mark, config.onActivate);
    },
    // Line text decides the marker, so every edit may move one.
    lineMarkerChange: (u) => u.docChanged,
  });
}
