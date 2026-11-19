import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (fr); merged into `../fr.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title":
    "Psyche a annulé une modification de sécurité faite en dehors de l’app",
  "notice.security.changed.body":
    "Un programme de ce Mac a modifié {count, plural, =1 {# enregistrement de sécurité} other {# enregistrements de sécurité}} (appareils, clés, autorisations ou réglages) sans passer par Psyche{times, plural, =0 {} =1 {} other {, # fois jusqu’ici}}. Psyche les a rétablis. Si ce n’était pas vous, vérifiez que le Mac n’a pas de logiciel indésirable.",
  "notice.security.untrusted.title": "Psyche ne peut pas se fier à ses enregistrements de sécurité",
  "notice.security.untrusted.body":
    "La vérification des enregistrements de sécurité de Psyche a échoué : les modifications de sécurité, les nouveaux appareils et les approbations par Touch ID sont bloqués. Vérifiez vos appareils, puis lancez `psyched security reseal` sur le Mac (effectif après 24 heures).",
  "notice.security.firstSeal.title": "Psyche vérifie désormais ses enregistrements de sécurité",
  "notice.security.firstSeal.body":
    "Psyche a scellé {devices, plural, =1 {# appareil associé} other {# appareils associés}} et ses réglages de sécurité. Désormais, une modification faite en dehors de Psyche est annulée et signalée ici. Vérifiez vos appareils une fois.",
  "notice.security.resealed.title":
    "{restored, select, yes {Enregistrements de sécurité scellés après une restauration} other {Enregistrements de sécurité scellés à nouveau}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche a démarré depuis une sauvegarde restaurée et a scellé ses enregistrements de sécurité tels quels. Si vous n’avez pas restauré de sauvegarde, vérifiez vos appareils.} other {Psyche a scellé à nouveau ses enregistrements de sécurité après le délai d’attente.}}",
  "notice.security.firstAdmin.title":
    "Une commande sur ce Mac a créé le premier appareil administrateur",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (clé {key})}} est devenu le premier appareil administrateur {via, select, desktop {depuis l’app Psyche} other {via `psyched`}} sur ce Mac. Si ce n’était pas vous, révoquez-le dans Réglages → Appareils.",
  "notice.security.recovery.title":
    "{state, select, requested {Une commande sur ce Mac a demandé une modification de sécurité} applied {Une modification de sécurité venant de ce Mac a été appliquée} cancelled {Une modification de sécurité venant de ce Mac a été annulée} other {Une modification de sécurité venant de ce Mac n’a pas pu être appliquée}}",
  "notice.security.recovery.body":
    "{op, select, approve {Approuver l’appareil {device}{key, select, none {} other { (clé {key})}} avec {scopes}.} grant {Donner à {device}{key, select, none {} other { (clé {key})}} {scopes}.} presence {Désactiver l’exigence de Touch ID et de clé d’accès pour les modifications de sécurité jusqu’à l’enregistrement d’une nouvelle clé.} seal {Accepter les enregistrements de sécurité actuels tels quels.} other {Une modification de sécurité.}}{state, select, requested { Elle s’applique {when, select, none {dans 24 heures} other {le {when}}} sauf si vous l’annulez dans Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche pilote votre Chrome",
  "notice.browser.chrome.body":
    "Une tâche utilise le profil Chrome de Psyche, où vous êtes connecté. Le titre de sa fenêtre indique « Psyche is driving this window ». Elle se ferme à la fin de la tâche ; vous pouvez aussi quitter Chrome.",
  "notice.browser.takeover.title": "Psyche a besoin de vous dans le navigateur",
  "notice.browser.takeover.body":
    "Sur {host}, l’agent demande : {reason}. Prenez la main dans le volet du navigateur, puis rendez-la.",
  "notice.connector.consent.title": "Terminer la connexion à Google",
  "notice.connector.consent.body":
    "Ouvrez ce lien sur l’ordinateur où Psyche s’exécute pour accorder l’accès : {url}",
  "notice.connector.changed.title": "Une connexion a changé",
  "notice.connector.changed.body":
    "{reason, select, account_changed {Un connecteur se connecte maintenant à un autre compte. Le travail lié à l’ancien compte a été arrêté.} disconnected {Un connecteur a été déconnecté. Le travail qui en avait besoin a été arrêté.} scope_changed {Un connecteur est maintenant en lecture seule. Les actions en attente par son intermédiaire ont été arrêtées.} other {L’accès d’un connecteur a été révoqué. Reconnectez-vous pour continuer à l’utiliser.}}",
  "notice.connector.reconnect.title": "Reconnexion nécessaire",
  "notice.connector.reconnect.body":
    "Un connecteur a perdu l’accès et vous devez vous reconnecter.",
  "notice.attention.paused.title": "Une tâche vous attend",
  "notice.attention.paused.body":
    "En pause avant {tool} sur une app ou un site sensible, jusqu’à votre retour dans Psyche.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {La clé {provider} a été {action, select, changed {modifiée} other {supprimée}}} other {La clé API {provider} a été {action, select, changed {modifiée} other {supprimée}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {Modifiée} other {Supprimée}} depuis {device, select, none {un appareil} other {"{device}" ({platform}{paired, select, none {} other {, associé le {paired}}})}}. Si ce n’était pas vous, révoquez l’appareil dans Réglages → Appareils.',
};
