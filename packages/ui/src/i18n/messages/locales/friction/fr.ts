import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (fr); merged into `../fr.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "Frictions liées aux autorisations",
  "friction.hint":
    "Combien de fois Psyche vous demande une autorisation avant d’agir, et comment vous répondez. Chiffres seulement, issus du journal d’audit.",
  "friction.window": "Période",
  "friction.window.days": "{days} derniers jours",
  "friction.loading": "Décompte des autorisations…",
  "friction.error": "Impossible de charger les frictions : {reason}",
  "friction.retry": "Réessayer",
  "friction.empty":
    "Psyche n’a vérifié aucune action sur cette période, il n’y a donc rien à afficher.",
  "friction.since": "Depuis le {date}",
  "friction.asked":
    "Demandé pour {asks, plural, one {# action} other {# actions}} sur {decisions, plural, one {# action vérifiée} other {# actions vérifiées}} ({rate} %).",
  "friction.perRun":
    "Les séances où Psyche a demandé au moins une fois ont eu en moyenne {n} demandes chacune.",
  "friction.answered":
    "Parmi les demandes terminées, {rate} % ont reçu une réponse avant d’expirer.",
  "friction.approved": "Parmi les demandes terminées, {rate} % ont été approuvées.",
  "friction.noTimes":
    "Aucune demande n’a reçu de réponse sur cette période, donc aucun délai de réponse.",
  "friction.times":
    "La réponse a pris {p50} en médiane. Le dixième le plus lent a pris {p90} ou plus.",
  "friction.expired":
    "{n, plural, =0 {Aucune demande n’a expiré sans réponse.} one {# demande a expiré sans réponse.} other {# demandes ont expiré sans réponse.}}",
  "friction.rejected":
    "{n, plural, =0 {Aucune réponse n’a été rejetée.} one {# réponse a été rejetée comme invalide.} other {# réponses ont été rejetées comme invalides.}}",
  "friction.saved":
    "{n, plural, =0 {Aucune action n’a été autorisée par une autorisation permanente sans carte.} one {# action a été autorisée par une autorisation permanente sans carte.} other {# actions ont été autorisées par une autorisation permanente sans carte.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {Aucune autorisation permanente n’a été créée.} one {# autorisation permanente a été créée.} other {# autorisations permanentes ont été créées.}}",
  "friction.kinds": "D’où viennent les demandes",
  "friction.kind.row":
    "{kind} : demandé {asks}, approuvé {approved}, refusé {declined}, expiré {expired}",
  "friction.rules": "Raisons les plus fréquentes de demander",
  "friction.rule.row": "{label} : {count}",
  "friction.rule.mode": "Votre réglage de mode",
  "friction.rule.taint": "Contenu venant de l’extérieur",
  "friction.rule.policy": "Votre politique",
  "friction.rule.designated": "Un lieu protégé",
  "friction.rule.site": "Une règle de site",
  "friction.rule.other": "Une autre règle",
  "friction.modes": "Par mode",
  "friction.mode.row": "{mode} : demandé {asks} sur {decisions}",

  "people.interactions.error": "Impossible de charger les interactions plus anciennes : {reason}",
  "people.interactions.older": "Afficher les plus anciennes",
  "people.interactions.retry": "Réessayer",
  "people.interactions.loadingMore": "Chargement…",
};
