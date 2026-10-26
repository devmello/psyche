import type { Catalogue } from "../../index.ts";

/** Output canvas strings (fr); merged into `../fr.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.label": "Canevas : {title}",
  "canvas.recents": "Résultats récents",
  "canvas.loading": "Chargement…",
  "canvas.missing": "Psyche n’a pas pu charger ce résultat.",
  "canvas.untrusted": "Issu de contenu non fiable",
  "canvas.version": "Version",
  "canvas.versionOption":
    "v{version} · {author, select, user {vous} specialist {spécialiste} other {Psyche}} · {time}",
  "canvas.copy": "Copier",
  "canvas.copied": "Copié",
  "canvas.download": "Télécharger",
  "canvas.restore": "Restaurer comme nouvelle version",
  "canvas.oldVersion": "Version {version} (lecture seule).",
  "canvas.conflict":
    "Cela a changé pendant votre modification, elle n’a donc pas été enregistrée. Réessayez sur la dernière version.",
  "canvas.saveFailed": "Enregistrement impossible : {message}",
};
