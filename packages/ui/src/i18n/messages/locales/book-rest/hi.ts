import type { Catalogue } from "../../index.ts";

/** `book.*` strings (hi); merged into `../hi.ts`. */
export const bookRest: Partial<Catalogue> = {
  "book.label": "स्प्रेडशीट: {title}",
  "book.sheets": "शीट",
  "book.addSheet": "शीट जोड़ें",
  "book.newSheet": "शीट {n}",
  "book.cell": "सेल {ref}",
  "book.formulaBar": "{ref} का मान या फ़ॉर्मूला",
  "book.hint": "फ़ॉर्मूले के लिए = से शुरू करें, जैसे =SUM(B2:B9)।",
  "book.cells": "{count, plural, one {# सेल} other {# सेल}}",
};
