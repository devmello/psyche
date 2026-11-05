import type { Catalogue } from "../../index.ts";

/** Completed gallery strings (fr); merged into `../fr.ts`. */
export const galleryRest: Partial<Catalogue> = {
  "gallery.intro":
    "Choisissez quelque chose à essayer. Chaque connecteur demande avant d’agir, et vous pouvez le retirer à tout moment.",
  "gallery.search": "Rechercher des connecteurs",
  "gallery.noMatch": "Aucun résultat. Essayez un autre mot, ou ajoutez votre propre serveur MCP.",
  "gallery.back": "Tous les connecteurs",
  "gallery.getKey": "Où l’obtenir.",
  "gallery.keyStaysInVault":
    "Il est conservé dans votre coffre, jamais dans les réglages du serveur.",
  "gallery.tryAsking": "Une fois ajouté, essayez de demander :",
  "gallery.custom.desc":
    "Tout serveur MCP : une commande qui s’exécute dans le bac à sable, ou une adresse web.",
  "gallery.badge.builtIn": "Intégré",
  "gallery.badge.official": "Officiel",
  "gallery.badge.community": "Communauté",
  "gallery.category.popular": "Populaires",
  "gallery.category.files": "Fichiers et connaissances",
  "gallery.category.dev": "Dev",
  "gallery.category.productivity": "Productivité",
  "gallery.category.comms": "Messages et e-mails",
  "gallery.category.web": "Web",
  "gallery.category.everyday": "Quotidien",
  "gallery.category.finance": "Finance",
  "gallery.category.custom": "Les vôtres",
  "gallery.builtin.google": "Gmail, Google Agenda et Drive.",
  "gallery.builtin.microsoft": "Courrier et calendrier Outlook.",
  "gallery.builtin.imap": "Tout compte de messagerie compatible IMAP.",
  "gallery.builtin.appleNotes": "Lire et compléter vos notes dans Notes Apple.",
  "gallery.builtin.appleReminders": "Voir et créer des rappels.",
  "gallery.builtin.appleCalendar": "Voir votre calendrier et ajouter des événements.",
  "gallery.builtin.appleMail": "Lire et rédiger des e-mails dans Mail Apple.",
  "gallery.builtin.appleShortcuts": "Exécuter les raccourcis que vous choisissez.",
  "gallery.builtin.obsidian": "Rechercher et lire votre coffre Obsidian.",
  "gallery.builtin.slack": "Discutez avec Psyche depuis Slack. À configurer dans Canaux.",
  "gallery.preset.github.desc": "Parcourir les dépôts, tickets et pull requests.",
  "gallery.preset.github.example": "Quelles pull requests attendent ma relecture ?",
  "gallery.preset.github.field.token.label": "Jeton d’accès personnel",
  "gallery.preset.github.field.token.help":
    "Un jeton à granularité fine, limité aux dépôts que Psyche doit pouvoir voir.",
  "gallery.preset.gitlab.desc":
    "Projets, merge requests et tickets sur GitLab.com. Vous vous connectez lors de la connexion.",
  "gallery.preset.gitlab.example": "Résume les merge requests ouvertes dans mon projet principal.",
  "gallery.preset.git.desc": "Lire l’historique, les branches et les différences d’un dépôt local.",
  "gallery.preset.git.example": "Qu’est-ce qui a changé dans ce dépôt la semaine dernière ?",
  "gallery.preset.git.field.repo.label": "Dossier du dépôt",
  "gallery.preset.git.field.repo.help":
    "Le dossier d’un dépôt Git sur ce Mac. Psyche peut en lire l’historique et les différences.",
  "gallery.preset.sentry.desc":
    "Examiner les erreurs et incidents de vos projets Sentry. Vous vous connectez lors de la connexion.",
  "gallery.preset.sentry.example":
    "Quelles sont les erreurs non résolues les plus fréquentes cette semaine ?",
  "gallery.preset.linear.desc":
    "Trouver et mettre à jour des tickets et des projets. Vous vous connectez lors de la connexion.",
  "gallery.preset.linear.example": "Quels tickets me sont assignés et à rendre cette semaine ?",
  "gallery.preset.jira.desc":
    "Rechercher des tickets Jira et des pages Confluence. Vous vous connectez lors de la connexion.",
  "gallery.preset.jira.example": "Affiche les tickets Jira que j’ai mis à jour hier.",
  "gallery.preset.notion.desc":
    "Rechercher, lire et modifier des pages dans votre espace de travail Notion. Vous vous connectez lors de la connexion.",
  "gallery.preset.notion.example": "Trouve dans Notion mes notes de réunion de mardi dernier.",
  "gallery.preset.todoist.desc":
    "Voir et gérer vos tâches et projets Todoist. Vous vous connectez lors de la connexion.",
  "gallery.preset.todoist.example": "Qu’est-ce qui est à faire aujourd’hui dans Todoist ?",
  "gallery.preset.airtable.desc":
    "Lire et mettre à jour les enregistrements de vos bases Airtable.",
  "gallery.preset.airtable.example":
    "Liste les enregistrements de ma base Projets marqués comme bloqués.",
  "gallery.preset.airtable.field.key.label": "Jeton d’accès personnel",
  "gallery.preset.airtable.field.key.help":
    "Créez un jeton capable de lire les bases que vous voulez utiliser.",
  "gallery.preset.fetch.desc": "Récupérer une page web et la lire en texte brut.",
  "gallery.preset.fetch.example": "Lis cette page et donne-moi les trois points clés.",
  "gallery.preset.fetch.field.sites.label": "Sites web accessibles",
  "gallery.preset.fetch.field.sites.help":
    "Noms d’hôte séparés par des virgules, par exemple en.wikipedia.org. Laissé vide, il ne peut accéder qu’au registre de paquets.",
  "gallery.preset.braveSearch.desc":
    "Rechercher sur le web, dans l’actualité et les images avec Brave.",
  "gallery.preset.braveSearch.example":
    "Recherche l’actualité de cette semaine sur les modèles d’IA open source.",
  "gallery.preset.braveSearch.field.key.label": "Clé API",
  "gallery.preset.braveSearch.field.key.help": "L’offre gratuite suffit pour essayer.",
  "gallery.preset.playwright.desc":
    "Piloter un navigateur séparé pour lire des pages et remplir des formulaires.",
  "gallery.preset.playwright.example": "Ouvre example.com et dis-moi ce que dit la page.",
  "gallery.preset.playwright.field.sites.label": "Sites web accessibles",
  "gallery.preset.playwright.field.sites.help":
    "Noms d’hôte séparés par des virgules qui peuvent être ouverts. Laissez vide pour le garder hors ligne.",
  "gallery.preset.firecrawl.desc": "Extraire et explorer des sites web sous forme de texte propre.",
  "gallery.preset.firecrawl.example":
    "Explore le site de documentation sur example.com et résume les sections principales.",
  "gallery.preset.firecrawl.field.key.label": "Clé API",
  "gallery.preset.firecrawl.field.key.help":
    "Utilisée pour extraire et explorer des sites pour vous.",
  "gallery.preset.time.desc": "Obtenir l’heure actuelle et convertir entre fuseaux horaires.",
  "gallery.preset.time.example": "Quelle heure est-il à Tokyo quand il est 9 h à San Francisco ?",
  "gallery.preset.homeAssistant.desc":
    "Voir et contrôler les appareils que vous exposez dans Home Assistant.",
  "gallery.preset.homeAssistant.example": "Quelles lumières sont allumées en ce moment ?",
  "gallery.preset.homeAssistant.field.url.label": "Adresse du serveur",
  "gallery.preset.homeAssistant.field.url.help":
    "Activez l’intégration Model Context Protocol Server, puis copiez son adresse depuis Paramètres, Système, IA. Elle doit commencer par https://.",
  "gallery.preset.stripe.desc":
    "Consulter les clients, paiements et soldes. Lecture seule, définie par votre clé restreinte.",
  "gallery.preset.stripe.example": "Combien ai-je facturé ces 30 derniers jours ?",
  "gallery.preset.stripe.field.key.label": "Clé restreinte",
  "gallery.preset.stripe.field.key.help":
    "Créez une clé restreinte (elle commence par rk_) avec l’autorisation de lecture uniquement. Les autres clés sont refusées ici.",
};
