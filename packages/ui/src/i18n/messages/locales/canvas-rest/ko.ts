import type { Catalogue } from "../../index.ts";

/** canvas strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const canvasRest: Partial<Catalogue> = {
  "canvas.export": "내보내기",
  "canvas.exportAs": "내보내기 형식…",
  "canvas.exportFailed": "내보내지 못했습니다: {message}",
  "canvas.loadingEditor": "편집기를 여는 중…",
  "canvas.invalid": "이 {kind, select, slides {슬라이드} other {스프레드시트}}를 읽을 수 없습니다.",
};
