import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (fr); merged into `../fr.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Vérification de l'assistant Linux",
  "settings.devices.helperCheck.description":
    "Quand l'assistant Linux se connecte, Psyche vérifie de quel programme il s'agit vraiment.",
  "settings.devices.helperCheck.state.verified": "Vérifié : assistant installé dans le système",
  "settings.devices.helperCheck.state.userOwned":
    "Non vérifié : assistant de votre dossier personnel",
  "settings.devices.helperCheck.state.unverified":
    "Non vérifié : Psyche n'a pas pu vérifier l'assistant",
  "settings.devices.helperCheck.detail.verified":
    "C'est l'assistant installé avec Psyche. Seul le système peut le modifier.",
  "settings.devices.helperCheck.detail.userOwned":
    "Il s'exécute depuis des fichiers qui vous appartiennent, comme un AppImage ou une version compilée dans votre dossier personnel. Psyche l'accepte, mais ne peut pas exclure qu'un autre de vos programmes l'ait remplacé.",
  "settings.devices.helperCheck.detail.unverified":
    "Psyche l'accepte pour l'instant, mais n'a pas pu déterminer de quel programme il s'agit.",
  "settings.devices.helperCheck.refused": "Refusé : {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche n'a pas pu vérifier l'assistant",
  "settings.devices.helperCheck.reason.notHelper": "ce programme n'est pas l'assistant de Psyche",
  "settings.devices.helperCheck.reason.userCopy":
    "c'est une copie hors de l'installation du système, et l'assistant installé est exigé",
  "settings.devices.helperCheck.reason.loaderEnv":
    "il a été lancé avec un chemin de bibliothèques ou une bibliothèque préchargée",
  "settings.devices.helperCheck.reason.foreignCode":
    "du code venant de l'extérieur du système y est chargé",
  "settings.devices.helperCheck.reason.severalPrograms":
    "plusieurs programmes partagent sa connexion",
  "settings.devices.helperCheck.reason.handedOver":
    "sa connexion lui a été transmise par un autre programme",
  "settings.devices.helperCheck.reason.stillStarting": "il était encore en train de démarrer",
  "settings.devices.helperCheck.reason.debugged": "il est arrêté ou en cours de débogage",
  "settings.devices.helperCheck.reason.restartNeeded":
    "il a été remplacé ou une bibliothèque système a été mise à jour depuis son démarrage ; redémarrez l'assistant",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "ses fichiers pourraient être modifiés par quelqu'un d'autre que le système",
  "settings.devices.helperCheck.reason.otherNamespace":
    "il s'exécute dans un bac à sable distinct de cet ordinateur",
  "settings.devices.helperCheck.reason.busy":
    "Psyche était occupé à vérifier d'autres connexions ; l'assistant réessaiera",
};
