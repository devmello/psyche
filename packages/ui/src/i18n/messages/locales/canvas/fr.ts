import type { Catalogue } from "../../index.ts";

/** Output canvas strings (fr); merged into `../fr.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Graphique",
  "canvas.htmlOff":
    "Ceci provient d’un contenu non fiable, l’aperçu est donc désactivé. Ne l’exécutez que si vous lui faites confiance. Il s’exécute dans un bac à sable sans réseau.",
  "canvas.htmlRun": "Exécuter",
  "canvas.htmlNoPreview": "Cet hôte ne peut pas afficher le HTML ; la source est affichée.",
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
  "canvas.map": "Carte",
  "map.label": "Carte : {title}",
  "map.untitled": "Carte",
  "map.list": "Lieux",
  "map.openLink": "Ouvrir le lien",
  "map.empty": "Aucun lieu à afficher.",
  "map.tilesOff": "Les tuiles de carte sont désactivées dans les Réglages. La liste est affichée.",
  "map.tilesFailed": "La carte n’a pas pu se charger. La liste est affichée.",
  "map.showMap": "Afficher la carte",
  "map.showList": "Afficher la liste",
  "map.card": "Carte : {title}",
  "map.meta": "{count, plural, one {# lieu} other {# lieux}} · {date}",
  "map.openCanvas": "Ouvrir dans le canevas",
  "map.invalid": "Cette carte est illisible.",
  "map.gesture.windows": "Ctrl + molette pour zoomer sur la carte",
  "map.gesture.mac": "⌘ + molette pour zoomer sur la carte",
  "map.gesture.mobile": "Utilisez deux doigts pour déplacer la carte",
  "settings.map.title": "Cartes",
  "settings.map.privacy":
    "Afficher une carte demande à un serveur de tuiles la zone que vous regardez ; il peut donc savoir à peu près où vous regardez. Désactivez les tuiles pour voir les lieux en liste seulement, ou utilisez votre propre serveur. Les requêtes passent par votre Gateway : le serveur de tuiles voit le Gateway, pas votre appareil.",
  "settings.map.tiles": "Afficher les tuiles de carte",
  "settings.map.tilesHint": "Désactivé affiche les lieux en liste, sans requête de carte.",
  "settings.map.style": "URL de style du serveur de tuiles",
  "settings.map.styleHint":
    "Une URL de style JSON MapLibre, par exemple celle de votre serveur. Vide utilise les tuiles gratuites d’OpenFreeMap (https uniquement ; http pour localhost).",
  "settings.map.styleDark": "URL de style (sombre)",
  "settings.map.styleDarkHint":
    "Facultatif. Vide utilise le style ci-dessus aussi en mode sombre, ou le style sombre d’OpenFreeMap.",
};
