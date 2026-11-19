import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (fr); merged into `../fr.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "L'assistant Psyche n'est pas connecté",
  "platform.helper.offline.text":
    "Le courrier, les notes, l'agenda, les rappels et le travail qui en dépend attendent sa reconnexion.",
  "platform.helper.offline.reconnect": "Reconnecter",
  "platform.helper.contactsPermission":
    "Les contacts ont besoin de l'autorisation de l'assistant Psyche dans Réglages Système.",
  "platform.helper.offline.dismiss": "Masquer",
  "platform.helper.choose.title": "Plus d'un Psyche Helper est connecté",
  "platform.helper.choose.text":
    "Psyche ne choisira pas à votre place, donc Mail, Notes, Calendrier et Rappels sont en pause. Choisissez celui à utiliser tant qu'ils sont tous connectés.",
  "platform.helper.choose.use": "Utiliser l'assistant associé le {when} (…{id})",
  "platform.helper.choose.useNoTime": "Utiliser l'assistant (…{id})",
  "platform.helper.choose.name": "Se nomme lui-même : {name}",
  "platform.helper.choose.failed": "Impossible de choisir l'assistant : {reason}",
};
