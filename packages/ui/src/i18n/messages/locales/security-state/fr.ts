import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (fr); merged into `../fr.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "Psyche a annulé une modification de ses données de sécurité faite en dehors de l’app.",
  "web.security.banner.untrusted":
    "La vérification des données de sécurité de Psyche a échoué. Les modifications qui élargissent l’accès sont bloquées.",
  "web.security.banner.recovery":
    "{count, plural, one {Une modification de sécurité demandée sur ce Mac s’applique le {when}, sauf si vous l’annulez.} other {# modifications de sécurité demandées sur ce Mac sont en attente. La prochaine s’applique le {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {1 avis de sécurité à examiner.} other {# avis de sécurité à examiner.}}",
  "web.security.review": "Examiner",
  "web.security.hide": "Masquer",
  "web.security.panel.label": "Données de sécurité",
  "web.security.alert.changed":
    "Un programme de ce Mac a modifié {count, plural, one {1 donnée de sécurité} other {# données de sécurité}} sans passer par Psyche. Psyche {count, plural, one {l’a rétablie} other {les a rétablies}}. Si ce n’était pas vous, recherchez un logiciel indésirable sur ce Mac.",
  "web.security.alert.untrusted":
    "La vérification des données de sécurité de Psyche a échoué. Les nouveaux appareils, les réglages de sécurité et les approbations Touch ID sont bloqués. Vérifiez vos appareils, puis exécutez psyched security reseal sur le Mac ; cela s’applique après 24 heures.",
  "web.security.alert.firstSeal":
    "Psyche vérifie désormais ses données de sécurité ({devices, plural, one {1 appareil jumelé} other {# appareils jumelés}}). Une modification faite en dehors de Psyche est annulée et affichée ici. Vérifiez vos appareils une fois.",
  "web.security.alert.resealed": "Psyche a scellé à nouveau ses données de sécurité.",
  "web.security.alert.restored":
    "Psyche a démarré à partir d’une sauvegarde restaurée et a scellé ses données de sécurité telles quelles. Si vous n’avez pas restauré de sauvegarde, vérifiez vos appareils.",
  "web.security.alert.firstAdmin":
    "Une commande sur ce Mac a fait de {name} le premier appareil administrateur. Si ce n’était pas vous, révoquez-le dans Appareils.",
  "web.security.alert.requested": "Demandé sur ce Mac : {action} S’applique le {when}.",
  "web.security.alert.applied": "Appliqué : {action}",
  "web.security.alert.cancelled": "Annulé : {action}",
  "web.security.alert.failed": "Impossible d’appliquer : {action}",
  "web.security.op.devicesApprove": "approuver l’appareil {name}.",
  "web.security.op.devicesGrant": "modifier ce que {name} peut faire.",
  "web.security.op.presenceReset":
    "effacer la clé qui protège les paiements jusqu’à l’enregistrement d’une nouvelle.",
  "web.security.op.sealReset": "accepter les données de sécurité actuelles telles quelles.",
  "web.security.device": "un appareil",
  "web.security.deviceKey": "{name} (clé {fingerprint})",
  "web.security.change":
    "{change, select, added {Ajouté} modified {Modifié} other {Supprimé}} : {what}",
  "web.security.more": "{count, plural, one {et 1 autre} other {et # autres}}",
  "web.security.ack": "Marquer comme examiné",
  "web.security.approveNow": "Approuver maintenant",
  "web.security.cancel": "Annuler la demande",
  "web.security.needsApprovalPresence":
    "Approuvez la carte avec Touch ID ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
  "web.security.needsApproval": "Approuve la carte, puis appuie de nouveau sur le bouton.",
  "web.security.failed": "Cela n’a pas fonctionné : {message}",
  "settings.security.title": "Données de sécurité",
  "settings.security.description":
    "Indique si les données de sécurité de Psyche sont intactes, ce qui a changé sans toi et les demandes en attente d'application.",
  "settings.security.status.sealed": "Intactes",
  "settings.security.status.untrusted": "Non fiables",
  "settings.security.empty": "Rien à examiner. Aucune alerte et aucune demande en attente.",
  "settings.security.approvalLabel": "Changement de sécurité",
  "settings.security.approve.title": "Appliquer ce changement maintenant ?",
  "settings.security.approve.body": "La demande s'applique maintenant au lieu du {when} : {action}",
  "settings.security.approve.confirm": "Appliquer maintenant",
  "settings.security.cancel.title": "Annuler cette demande ?",
  "settings.security.cancel.body":
    "Le changement ne sera pas fait et la demande est abandonnée : {action}",
  "settings.security.keep": "La garder",
};
