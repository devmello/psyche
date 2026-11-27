import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (fr); merged into `../fr.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "Appareils",
  "simplifyB4.devices.description": "Les ordinateurs et iPhone qui peuvent utiliser Psyche.",
  "simplifyB4.devices.details": "Détails",
  "simplifyB4.devices.canDo": "Ce qu’il peut faire",
  "simplifyB4.devices.canDoOf": "Ce que {name} peut faire",
  "simplifyB4.devices.hostKey": "Clé de cet ordinateur : {fingerprint}",
  "simplifyB4.devices.helpers": "Assistants",
  "simplifyB4.devices.helpersHint": "Les petites apps qui permettent à Psyche de travailler sur un ordinateur.",
  "simplifyB4.devices.noHelpers": "Aucun assistant pour l’instant. Un assistant apparaît ici dès que Psyche tourne sur un ordinateur.",
  "simplifyB4.server.title": "Réseau et accès à distance",
  "simplifyB4.server.description": "Comment les autres appareils joignent cet ordinateur, et comment utiliser Psyche hors de chez vous.",
  "simplifyB4.server.away": "L’utiliser hors de chez vous",
  "simplifyB4.pairIphone.title": "Associer l’iPhone",
  "simplifyB4.pairIphone.description": "Scannez un code avec Psyche sur votre iPhone. L’iPhone et cet ordinateur doivent être sur le même Wi-Fi.",
  "simplifyB4.pairIphone.button": "Associer l’iPhone",
  "simplifyB4.pairIphone.scan": "Ouvrez Psyche sur votre iPhone et scannez ce code. Il ne fonctionne qu’une fois.",
  "simplifyB4.pairIphone.lanOn": "L’association a activé l’accès réseau pour que votre iPhone trouve cet ordinateur.",
  "simplifyB4.pairIphone.lanOff": "L’accès réseau est de nouveau désactivé.",
  "simplifyB4.pairIphone.turnOff": "Désactiver l’accès réseau",
  "simplifyB4.pairIphone.enableFailed": "Impossible d’activer l’accès réseau : {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "Impossible de désactiver l’accès réseau : {reason}",
  "simplifyB4.pairIphone.noNetwork": "Cet ordinateur n’est pas joignable sur votre réseau pour le moment. Vérifiez que le Wi-Fi est activé, puis réessayez.",
};
