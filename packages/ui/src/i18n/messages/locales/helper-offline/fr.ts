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
};
