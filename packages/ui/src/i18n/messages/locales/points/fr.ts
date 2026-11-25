import type { Catalogue } from "../../index.ts";

/** Psyche points (fr); merged into `../fr.ts`. */
export const points: Partial<Catalogue> = {
  "points.sheet.title": "Guide-moi dans un formulaire",
  "points.sheet.description":
    "Choisis une fenêtre et Psyche désigne le prochain champ à remplir. Les clics et la saisie, c'est toi.",
  "points.sheet.windows.label": "Fenêtre",
  "points.sheet.windows.loading": "Recherche des fenêtres…",
  "points.sheet.windows.empty": "Aucune fenêtre à désigner. Ouvre le formulaire, puis réessaie.",
  "points.sheet.windows.error":
    "Impossible de lister tes fenêtres. Vérifie que Psyche Helper est lancé, puis réessaie.",
  "points.sheet.windows.retry": "Réessayer",
  "points.sheet.window.untitled": "Fenêtre sans titre",
  "points.sheet.window.frontmost": "Au premier plan",
  "points.refusal.never_app": "Psyche ne guide pas dans cette app.",
  "points.refusal.fixed_off": "Cette app est interdite à Psyche.",
  "points.refusal.terminal_or_ide":
    "Les terminaux et les éditeurs de code ne sont pas des formulaires.",
  "points.refusal.owner_off": "Tu as désactivé cette app dans les Réglages.",
  "points.refusal.not_a_window": "Psyche ne peut pas lire cette fenêtre.",
  "points.refusal.permission_missing": "Autorise l'Accessibilité pour lire cette fenêtre.",
  "points.sheet.goal.label": "À quoi sert ce formulaire ? (facultatif)",
  "points.sheet.goal.placeholder": "Déclaration de revenus 2026, imposition commune",
  "points.sheet.data.provider":
    "Psyche envoie à {provider} les libellés du formulaire et ce que tu saisis, sauf mots de passe et numéros de carte, de compte bancaire ou de pièce d'identité, pour te guider.",
  "points.sheet.data.local": "Cela reste sur cet ordinateur.",
  "points.sheet.data.providerFallback": "ton fournisseur de modèle",
  "points.sheet.payments":
    "Sur les pages de paiement, Psyche donne seulement des indications. Tu remplis ces champs toi-même.",
  "points.sheet.permission.hint":
    "Psyche lit la fenêtre via l'Accessibilité. Autorise-la pour Psyche Helper afin de commencer.",
  "points.sheet.start": "Commencer à guider",
  "points.sheet.starting": "Démarrage…",
  "points.sheet.cancel": "Annuler",
  "points.sheet.startFailed": "Impossible de commencer à guider. Réessaie.",
  "points.sheet.session.active": "Guidage dans {app}",
  "points.sheet.session.stop": "Arrêter de guider",
  "points.state.reading": "Lecture du formulaire…",
  "points.state.pointing": "Champ {step} sur {of}",
  "points.state.paused": "En pause",
  "points.needs.screenRecording.title":
    "Laisser Psyche regarder nécessite l'enregistrement de l'écran",
  "points.needs.screenRecording.hint":
    "Psyche n'envoie une image de cette fenêtre que si tu appuies sur Laisser Psyche regarder.",
  "points.needs.done": "Terminé",
  "points.offer.button": "Guide-moi",
  "points.offer.hint": "Psyche montre où regarder. Tu cliques et tu saisis.",
  "points.offer.elsewhere":
    "Lance Psyche points sur l'ordinateur où Psyche s'exécute : appuie sur {keys}, puis choisis Guide-moi dans un formulaire.",
  "points.palette.start": "Guide-moi dans un formulaire",
  "points.palette.keywords":
    "psyche points flèche guider formulaire remplir impôts visa démarches aide",
  "points.settings.title": "Psyche points",
  "points.settings.description":
    "Choisis une fenêtre et Psyche désigne le prochain champ à remplir. Il ne clique ni ne saisit jamais.",
  "points.settings.enabledHint":
    "Ajoute Guide-moi dans un formulaire à la palette de commandes et au menu de la barre des menus.",
  "settings.key.points.enabled": "Me guider dans les formulaires",
  "points.card.back": "Retour",
  "points.card.skip": "Passer",
  "points.card.next": "Suivant",
  "points.card.looksWrong": "Ça semble faux ?",
  "points.card.stuck": "Bloqué ?",
  "points.card.stuckMissing": "Je ne l'ai pas",
  "points.card.stuckUnclear": "Je ne comprends pas",
  "points.card.stuckBlocked": "Ça ne me laisse pas faire",
  "points.card.askInPsyche": "Demander dans Psyche…",
  "points.card.letLook": "Laisser Psyche regarder",
  "points.card.stop": "Arrêter",
  "points.card.hideNote": "Masquer la note",
  "points.card.copy": "Copier",
  "points.card.selfFill": "À remplir toi-même : {label}",
  "points.card.selfFillPlain": "À remplir toi-même",
  "points.card.payButton": "Ce bouton paie. Vérifie le montant, puis décide toi-même.",
  "points.card.unknownValue": "Psyche ne connaît pas cette information.",
  "points.card.scrollTo": "Fais défiler jusqu'à {label}",
  "points.card.menuBarTitle": "◉ Guidage : {app}",
  "points.card.stepFormat": "{n}/{total}",
  "points.card.visionBadge": "Utilise une image de cette fenêtre",
  "points.card.followWindow": "Suivre cette fenêtre",
};
