import type { Catalogue } from "../../index.ts";

/** `gallery.*` strings (it); merged into `../it.ts`. */
export const galleryRest: Partial<Catalogue> = {
  "gallery.intro":
    "Scegli qualcosa da provare. Ogni connettore chiede prima di fare qualsiasi cosa e puoi rimuoverlo quando vuoi.",
  "gallery.search": "Cerca connettori",
  "gallery.noMatch": "Nessun risultato. Prova un’altra parola, oppure aggiungi il tuo server MCP.",
  "gallery.back": "Tutti i connettori",
  "gallery.getKey": "Dove ottenerla.",
  "gallery.keyStaysInVault": "Viene conservata nel tuo vault, mai nelle impostazioni del server.",
  "gallery.tryAsking": "Dopo averlo aggiunto, prova a chiedere:",
  "gallery.custom.desc":
    "Qualsiasi server MCP: un comando eseguito nella sandbox, oppure un indirizzo web.",
  "gallery.badge.builtIn": "Integrato",
  "gallery.badge.official": "Ufficiale",
  "gallery.badge.community": "Community",
  "gallery.category.popular": "Popolari",
  "gallery.category.files": "File e conoscenza",
  "gallery.category.dev": "Sviluppo",
  "gallery.category.productivity": "Produttività",
  "gallery.category.comms": "Messaggi ed email",
  "gallery.category.web": "Web",
  "gallery.category.everyday": "Vita quotidiana",
  "gallery.category.finance": "Finanza",
  "gallery.category.custom": "Personalizzati",
  "gallery.builtin.google": "Gmail, Google Calendar e Drive.",
  "gallery.builtin.microsoft": "Posta e calendario di Outlook.",
  "gallery.builtin.imap": "Qualsiasi account di posta che supporti IMAP.",
  "gallery.builtin.appleNotes": "Leggi e aggiungi alle tue note in Note di Apple.",
  "gallery.builtin.appleReminders": "Vedi e crea promemoria.",
  "gallery.builtin.appleCalendar": "Vedi il tuo calendario e aggiungi eventi.",
  "gallery.builtin.appleMail": "Leggi e prepara bozze di posta in Mail di Apple.",
  "gallery.builtin.appleShortcuts": "Esegui i Comandi rapidi che scegli.",
  "gallery.builtin.obsidian": "Cerca e leggi nel tuo vault Obsidian.",
  "gallery.builtin.slack": "Chatta con Psyche da Slack. Si configura in Canali.",
  "gallery.preset.github.desc": "Sfoglia repository, issue e pull request.",
  "gallery.preset.github.example": "Quali pull request aspettano la mia revisione?",
  "gallery.preset.github.field.token.label": "Token di accesso personale",
  "gallery.preset.github.field.token.help":
    "Un token granulare limitato ai repository che vuoi far vedere a Psyche.",
  "gallery.preset.gitlab.desc":
    "Progetti, merge request e issue su GitLab.com. Accedi quando si collega.",
  "gallery.preset.gitlab.example": "Riassumi le merge request aperte nel mio progetto principale.",
  "gallery.preset.git.desc": "Leggi cronologia, branch e differenze di un repository locale.",
  "gallery.preset.git.example": "Cosa è cambiato in questo repository nell’ultima settimana?",
  "gallery.preset.git.field.repo.label": "Cartella del repository",
  "gallery.preset.git.field.repo.help":
    "La cartella di un repository Git su questo Mac. Psyche può leggerne cronologia e differenze.",
  "gallery.preset.sentry.desc":
    "Analizza errori e problemi nei tuoi progetti Sentry. Accedi quando si collega.",
  "gallery.preset.sentry.example":
    "Quali sono gli errori irrisolti più frequenti questa settimana?",
  "gallery.preset.linear.desc": "Trova e aggiorna issue e progetti. Accedi quando si collega.",
  "gallery.preset.linear.example":
    "Quali issue sono assegnate a me e in scadenza questa settimana?",
  "gallery.preset.jira.desc":
    "Cerca issue di Jira e pagine di Confluence. Accedi quando si collega.",
  "gallery.preset.jira.example": "Mostra i ticket Jira che ho aggiornato ieri.",
  "gallery.preset.notion.desc":
    "Cerca, leggi e modifica le pagine del tuo spazio di lavoro Notion. Accedi quando si collega.",
  "gallery.preset.notion.example": "Trova in Notion le mie note della riunione di martedì scorso.",
  "gallery.preset.todoist.desc":
    "Vedi e gestisci le tue attività e i progetti di Todoist. Accedi quando si collega.",
  "gallery.preset.todoist.example": "Cosa scade oggi in Todoist?",
  "gallery.preset.airtable.desc": "Leggi e aggiorna i record delle tue base Airtable.",
  "gallery.preset.airtable.example":
    "Elenca i record della mia base Progetti contrassegnati come bloccati.",
  "gallery.preset.airtable.field.key.label": "Token di accesso personale",
  "gallery.preset.airtable.field.key.help":
    "Crea un token che possa leggere le base che vuoi usare.",
  "gallery.preset.fetch.desc": "Scarica una pagina web e leggila come testo semplice.",
  "gallery.preset.fetch.example": "Leggi questa pagina e dammi i tre punti chiave.",
  "gallery.preset.fetch.field.sites.label": "Siti web raggiungibili",
  "gallery.preset.fetch.field.sites.help":
    "Nomi host separati da virgole, ad esempio en.wikipedia.org. Se lasci vuoto, può raggiungere solo il registro dei pacchetti.",
  "gallery.preset.braveSearch.desc": "Cerca nel web, tra le notizie e le immagini con Brave.",
  "gallery.preset.braveSearch.example":
    "Cerca le notizie di questa settimana sui modelli di IA open source.",
  "gallery.preset.braveSearch.field.key.label": "Chiave API",
  "gallery.preset.braveSearch.field.key.help": "Il piano gratuito basta per provarlo.",
  "gallery.preset.playwright.desc":
    "Controlla un browser separato per leggere pagine e compilare moduli.",
  "gallery.preset.playwright.example": "Apri example.com e dimmi cosa c’è scritto nella pagina.",
  "gallery.preset.playwright.field.sites.label": "Siti web raggiungibili",
  "gallery.preset.playwright.field.sites.help":
    "Nomi host separati da virgole che può aprire. Lascia vuoto per tenerlo offline.",
  "gallery.preset.firecrawl.desc": "Estrai e analizza siti web in testo pulito.",
  "gallery.preset.firecrawl.example":
    "Analizza il sito della documentazione su example.com e riassumi le sezioni principali.",
  "gallery.preset.firecrawl.field.key.label": "Chiave API",
  "gallery.preset.firecrawl.field.key.help": "Serve per estrarre e analizzare i siti al posto tuo.",
  "gallery.preset.time.desc": "Ottieni l’ora attuale e converti tra fusi orari.",
  "gallery.preset.time.example":
    "Che ore sono a Tokyo quando a San Francisco sono le 9 del mattino?",
  "gallery.preset.homeAssistant.desc":
    "Vedi e controlla i dispositivi che esponi in Home Assistant.",
  "gallery.preset.homeAssistant.example": "Quali luci sono accese adesso?",
  "gallery.preset.homeAssistant.field.url.label": "Indirizzo del server",
  "gallery.preset.homeAssistant.field.url.help":
    "Attiva l’integrazione Model Context Protocol Server, poi copia il suo indirizzo da Impostazioni, Sistema, IA. Deve iniziare con https://.",
  "gallery.preset.stripe.desc":
    "Cerca clienti, pagamenti e saldi. Sola lettura, stabilita dalla tua chiave con restrizioni.",
  "gallery.preset.stripe.example": "Quanto ho addebitato negli ultimi 30 giorni?",
  "gallery.preset.stripe.field.key.label": "Chiave con restrizioni",
  "gallery.preset.stripe.field.key.help":
    "Crea una chiave con restrizioni (inizia con rk_) con il solo permesso di lettura. Le altre chiavi vengono rifiutate qui.",
};
