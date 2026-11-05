import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (fr); merged into `../fr.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth":
    "Nécessite votre mot de passe ou une clé d'accès pour être approuvé.",
  "blocks.approval.password.waiting":
    "Saisissez votre mot de passe dans la boîte de dialogue du système pour approuver {code}",
  "blocks.approval.password.waitingShort": "En attente de votre mot de passe…",
  "blocks.approval.password.onceOnly":
    "Les approbations par mot de passe depuis cette fenêtre ne valent qu'une fois.",
  "blocks.approval.status.allowedOncePassword":
    "Autorisé une fois (les approbations par mot de passe depuis cette fenêtre ne valent qu'une fois)",
  "blocks.approval.password.noUnsandboxed":
    "L'exécution d'une commande sans le bac à sable ne peut pas être approuvée par mot de passe depuis cette fenêtre. Configurez plutôt le bac à sable",
  "blocks.approval.password.cancelled":
    "La boîte de dialogue du mot de passe a été annulée, rien n'a donc été approuvé",
  "blocks.approval.password.failed":
    "Le mot de passe n'a pas été accepté, rien n'a donc été approuvé. Réessayez.",
  "blocks.approval.password.unavailableHere":
    "Approuvez depuis cet ordinateur, ou avec une clé d'accès depuis un autre appareil.",
  "blocks.approval.password.agentMissing":
    "Aucune boîte de dialogue de mot de passe n'est disponible sur ce bureau. Installez un agent polkit tel que polkit-gnome ou lxpolkit, ou utilisez une clé d'accès.",
  "blocks.approval.password.policyMissing":
    "La politique de mot de passe de Psyche n'est pas installée sur cet ordinateur. Lancez la configuration unique de Psyche, ou utilisez une clé d'accès.",
  "blocks.approval.password.notEnforced":
    "Une règle polkit sur cet ordinateur approuve Psyche sans mot de passe : impossible de confirmer que c'est bien vous. Supprimez la règle, ou utilisez une clé d'accès.",
  "blocks.approval.password.unreachable":
    "Le service de mot de passe du système n'est pas disponible. Réessayez, ou utilisez une clé d'accès.",
  "settings.devices.password.title": "Approbations par mot de passe",
  "settings.devices.password.description":
    "Avant d'approuver une action sensible, Psyche demande votre mot de passe dans la boîte de dialogue du système. Le mot de passe n'arrive jamais à Psyche.",
  "settings.devices.password.state.ready": "Prêt",
  "settings.devices.password.state.policyMissing": "Politique non installée",
  "settings.devices.password.state.notEnforced": "Désactivé",
  "settings.devices.password.state.noSession": "Aucune session de bureau",
  "settings.devices.password.state.agentMissing": "Pas de boîte de dialogue",
  "settings.devices.password.state.unavailable": "Indisponible",
  "settings.devices.password.detail.ready":
    "Psyche demande votre mot de passe dans la boîte de dialogue du système quand vous approuvez une action sensible.",
  "settings.devices.password.detail.policyMissing":
    "La politique de mot de passe de Psyche n'est pas installée sur cet ordinateur. Lancez la configuration unique de Psyche.",
  "settings.devices.password.detail.notEnforced":
    "Une règle polkit sur cet ordinateur approuve Psyche sans mot de passe. Les approbations par mot de passe sont désactivées tant qu'elle n'est pas supprimée.",
  "settings.devices.password.detail.noSession":
    "Les approbations par mot de passe nécessitent une session de bureau active sur cet ordinateur. Ouvrez Psyche à cet endroit.",
  "settings.devices.password.detail.agentMissing":
    "Aucune boîte de dialogue de mot de passe n'est disponible sur ce bureau. Installez un agent polkit tel que polkit-gnome ou lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "Psyche n'a pas pu joindre le service de mot de passe du système.",
  "settings.devices.password.x11Warning":
    "Il s'agit d'une session X11. D'autres programmes peuvent lire ce que vous saisissez ici : un mot de passe est un frein, pas une frontière. Une session Wayland est plus sûre.",
};
