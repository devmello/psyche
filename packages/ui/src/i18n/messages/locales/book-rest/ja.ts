import type { Catalogue } from "../../index.ts";

/** book strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const bookRest: Partial<Catalogue> = {
  "book.label": "スプレッドシート: {title}",
  "book.sheets": "シート",
  "book.addSheet": "シートを追加",
  "book.newSheet": "シート{n}",
  "book.cell": "セル{ref}",
  "book.formulaBar": "{ref}の値または数式",
  "book.hint": "=で始めると数式になります。例: =SUM(B2:B9)",
  "book.cells": "{count, plural, other {#個のセル}}",
};
