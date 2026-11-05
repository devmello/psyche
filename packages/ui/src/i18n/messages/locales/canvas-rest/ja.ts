import type { Catalogue } from "../../index.ts";

/** canvas strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const canvasRest: Partial<Catalogue> = {
  "canvas.export": "書き出し",
  "canvas.exportAs": "書き出し形式…",
  "canvas.exportFailed": "書き出せませんでした: {message}",
  "canvas.loadingEditor": "エディタを開いています…",
  "canvas.invalid":
    "この{kind, select, slides {スライド} other {スプレッドシート}}を読み取れませんでした。",
};
