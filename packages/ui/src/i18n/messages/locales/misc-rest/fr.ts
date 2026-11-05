import type { Catalogue } from "../../index.ts";

/** Completed misc strings (fr); merged into `../fr.ts`. */
export const miscRest: Partial<Catalogue> = {
  "common.avatarCount":
    "{label}, {n, plural, one {# a besoin de vous} other {# ont besoin de vous}}",
  "canvas.export": "Exporter",
  "canvas.exportAs": "Exporter en tant que…",
  "canvas.exportFailed": "Échec de l’export : {message}",
  "canvas.loadingEditor": "Ouverture de l’éditeur…",
  "canvas.invalid":
    "{kind, select, slides {Cette présentation} other {Ce tableau}} n’a pas pu être lu.",
  "book.label": "Tableur : {title}",
  "book.sheets": "Feuilles",
  "book.addSheet": "Ajouter une feuille",
  "book.newSheet": "Feuille {n}",
  "book.cell": "Cellule {ref}",
  "book.formulaBar": "Valeur ou formule pour {ref}",
  "book.hint": "Commencez par = pour une formule, par exemple =SOMME(B2:B9).",
  "book.cells": "{count, plural, one {# cellule} other {# cellules}}",
};
