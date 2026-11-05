import type { Catalogue } from "../../index.ts";

/** `book.*` strings (it); merged into `../it.ts`. */
export const bookRest: Partial<Catalogue> = {
  "book.label": "Foglio di calcolo: {title}",
  "book.sheets": "Fogli",
  "book.addSheet": "Aggiungi foglio",
  "book.newSheet": "Foglio {n}",
  "book.cell": "Cella {ref}",
  "book.formulaBar": "Valore o formula per {ref}",
  "book.hint": "Inizia con = per una formula, ad esempio =SUM(B2:B9).",
  "book.cells": "{count, plural, one {# cella} other {# celle}}",
};
