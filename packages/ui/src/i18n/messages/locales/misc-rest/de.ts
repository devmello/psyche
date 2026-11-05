import type { Catalogue } from "../../index.ts";

/** Completed misc strings (de); merged into `../de.ts`. */
export const miscRest: Partial<Catalogue> = {
  "common.avatarCount": "{label}, {n, plural, one {# braucht dich} other {# brauchen dich}}",
  "canvas.export": "Exportieren",
  "canvas.exportAs": "Exportieren als …",
  "canvas.exportFailed": "Export fehlgeschlagen: {message}",
  "canvas.loadingEditor": "Editor wird geöffnet …",
  "canvas.invalid":
    "{kind, select, slides {Diese Präsentation} other {Diese Tabelle}} konnte nicht gelesen werden.",
  "book.label": "Tabelle: {title}",
  "book.sheets": "Blätter",
  "book.addSheet": "Blatt hinzufügen",
  "book.newSheet": "Blatt {n}",
  "book.cell": "Zelle {ref}",
  "book.formulaBar": "Wert oder Formel für {ref}",
  "book.hint": "Beginne mit = für eine Formel, zum Beispiel =SUMME(B2:B9).",
  "book.cells": "{count, plural, one {# Zelle} other {# Zellen}}",
};
