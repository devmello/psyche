import type { Catalogue } from "../../index.ts";

/** book strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const bookRest: Partial<Catalogue> = {
  "book.label": "스프레드시트: {title}",
  "book.sheets": "시트",
  "book.addSheet": "시트 추가",
  "book.newSheet": "시트 {n}",
  "book.cell": "셀 {ref}",
  "book.formulaBar": "{ref}의 값 또는 수식",
  "book.hint": "=로 시작하면 수식이 됩니다. 예: =SUM(B2:B9)",
  "book.cells": "{count, plural, other {셀 #개}}",
};
