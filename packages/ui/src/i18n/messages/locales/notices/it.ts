import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (it); merged into `../it.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title":
    "Psyche ha annullato una modifica di sicurezza fatta fuori dall’app",
  "notice.security.changed.body":
    "Un programma su questo Mac ha modificato {count, plural, =1 {# registro di sicurezza} other {# registri di sicurezza}} (dispositivi, chiavi, permessi o impostazioni) senza passare da Psyche{times, plural, =0 {} =1 {} other {, finora # volte}}. Psyche li ha ripristinati. Se non sei stato tu, controlla che il Mac non abbia software indesiderato.",
  "notice.security.untrusted.title": "Psyche non può fidarsi dei suoi registri di sicurezza",
  "notice.security.untrusted.body":
    "Il controllo dei registri di sicurezza di Psyche non è riuscito, quindi le modifiche di sicurezza, i nuovi dispositivi e le approvazioni con Touch ID sono bloccati. Controlla i tuoi dispositivi, poi esegui `psyched security reseal` sul Mac (vale dopo 24 ore).",
  "notice.security.firstSeal.title": "Psyche ora controlla i suoi registri di sicurezza",
  "notice.security.firstSeal.body":
    "Psyche ha sigillato {devices, plural, =1 {# dispositivo associato} other {# dispositivi associati}} e le sue impostazioni di sicurezza. D’ora in poi una modifica fatta fuori da Psyche viene annullata e mostrata qui. Controlla i tuoi dispositivi una volta.",
  "notice.security.resealed.title":
    "{restored, select, yes {Registri di sicurezza sigillati dopo un ripristino} other {Registri di sicurezza sigillati di nuovo}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche è partito da un backup ripristinato e ha sigillato i suoi registri di sicurezza così come sono. Se non hai ripristinato un backup, controlla i tuoi dispositivi.} other {Psyche ha sigillato di nuovo i suoi registri di sicurezza dopo il periodo di attesa.}}",
  "notice.security.firstAdmin.title":
    "Un comando su questo Mac ha creato il primo dispositivo amministratore",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (chiave {key})}} è diventato il primo dispositivo amministratore {via, select, desktop {dall’app Psyche} other {tramite `psyched`}} su questo Mac. Se non sei stato tu, revocalo in Impostazioni → Dispositivi.",
  "notice.security.recovery.title":
    "{state, select, requested {Un comando su questo Mac ha chiesto una modifica di sicurezza} applied {Una modifica di sicurezza da questo Mac è stata applicata} cancelled {Una modifica di sicurezza da questo Mac è stata annullata} other {Una modifica di sicurezza da questo Mac non è stata applicata}}",
  "notice.security.recovery.body":
    "{op, select, approve {Approvare il dispositivo {device}{key, select, none {} other { (chiave {key})}} con {scopes}.} grant {Dare a {device}{key, select, none {} other { (chiave {key})}} {scopes}.} presence {Disattivare l’obbligo di Touch ID e passkey per le modifiche di sicurezza finché non viene registrata una nuova chiave.} seal {Accettare i registri di sicurezza attuali così come sono.} other {Una modifica di sicurezza.}}{state, select, requested { Viene applicata {when, select, none {tra 24 ore} other {il {when}}} se non la annulli in Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche sta usando il tuo Chrome",
  "notice.browser.chrome.body":
    "Un’attività usa il profilo Chrome di Psyche, dove hai effettuato l’accesso. Il titolo della finestra dice “Psyche is driving this window”. Si chiude al termine dell’attività; puoi anche chiudere Chrome.",
  "notice.browser.takeover.title": "Psyche ha bisogno di te nel browser",
  "notice.browser.takeover.body":
    "Su {host}, l’agente chiede: {reason}. Prendi il controllo nel pannello del browser, poi restituiscilo.",
  "notice.connector.consent.title": "Completa il collegamento a Google",
  "notice.connector.consent.body":
    "Apri questo link sul computer su cui è in esecuzione Psyche per concedere l’accesso: {url}",
  "notice.connector.changed.title": "Una connessione è cambiata",
  "notice.connector.changed.body":
    "{reason, select, account_changed {Un connettore ora accede a un altro account. Il lavoro legato al vecchio account è stato fermato.} disconnected {Un connettore è stato disconnesso. Il lavoro che ne aveva bisogno è stato fermato.} scope_changed {Un connettore ora è di sola lettura. Le azioni in sospeso tramite esso sono state fermate.} other {L’accesso di un connettore è stato revocato. Accedi di nuovo per continuare a usarlo.}}",
  "notice.connector.reconnect.title": "Serve riconnettersi",
  "notice.connector.reconnect.body": "Un connettore ha perso l’accesso e devi accedere di nuovo.",
  "notice.attention.paused.title": "Un’attività ti aspetta",
  "notice.attention.paused.body":
    "In pausa prima di {tool} su un’app o un sito sensibile, finché non torni in Psyche.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {La chiave {provider} è stata {action, select, changed {modificata} other {rimossa}}} other {La chiave API di {provider} è stata {action, select, changed {modificata} other {rimossa}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {Modificata} other {Rimossa}} da {device, select, none {un dispositivo} other {"{device}" ({platform}{paired, select, none {} other {, associato il {paired}}})}}. Se non sei stato tu, revoca il dispositivo in Impostazioni → Dispositivi.',
  "notice.approvals.digest.title":
    "{count, plural, =1 {# azione delle tue automazioni è in attesa} other {# azioni delle tue automazioni sono in attesa}}",
  "notice.approvals.digest.body": "Apri Approvazioni per approvarle o rifiutarle",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {Un'azione approvata di un'automazione non è stata eseguita} other {{automation}: l'azione approvata non è stata eseguita}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {L'approvazione è scaduta prima che l'automazione arrivasse all'azione, quindi non è stato fatto nulla. Se ne ha ancora bisogno, chiederà di nuovo.} paused {L'automazione è in pausa o è stata rimossa, quindi non è stata eseguita di nuovo e non è stato fatto nulla. Se ne ha ancora bisogno, chiederà di nuovo.} restart {Psyche si è riavviato prima che l'automazione potesse essere eseguita di nuovo, quindi non è stato fatto nulla. Se ne ha ancora bisogno, chiederà di nuovo.} restart_kept {Psyche si è riavviato prima che l'automazione potesse essere eseguita di nuovo. Il permesso che hai dato resta, quindi la prossima esecuzione farà questo senza chiedere. Per ritirarlo, revocalo in Permessi permanenti, in Approvazioni.} failed {L'automazione ha eseguito di nuovo l'azione, ma non è riuscita. Guarda Attività per capire cosa è andato storto. Se ne ha ancora bisogno, chiederà di nuovo.} failed_kept {L'automazione ha eseguito di nuovo l'azione, ma non è riuscita. Guarda Attività per capire cosa è andato storto. Il permesso che hai dato resta, quindi la prossima esecuzione riproverà senza chiedere. Per ritirarlo, revocalo in Permessi permanenti, in Approvazioni.} unknown {L'automazione ha eseguito di nuovo l'azione, ma Psyche non può sapere se è riuscita. Controlla Attività per verificarlo.} not_reached_kept {L'automazione è stata eseguita di nuovo ma non è arrivata alla stessa azione, quindi non è stato fatto nulla. Il permesso che hai dato resta, quindi la prossima esecuzione farà questo senza chiedere. Per ritirarlo, revocalo in Permessi permanenti, in Approvazioni.} other {L'automazione è stata eseguita di nuovo ma non è arrivata alla stessa azione, quindi non è stato fatto nulla. Se ne ha ancora bisogno, chiederà di nuovo.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} ha finito {title}} partial {{who} si è fermato presto su {title}} cancelled {{who} è stato fermato su {title}} other {{who} non è riuscito a finire {title}}}",
  "notice.specialist.result.body":
    "{outcome, select, done {Fatto} partial {Parziale} cancelled {Annullato} other {Non riuscito}}{findings, plural, =0 {} one { · # risultato} other { · # risultati}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {meno di 1 min} other {# min}}",
  "notice.mcp.changed.title": "Il server MCP {server} ha cambiato i suoi strumenti",
  "notice.mcp.suspicious.title": "Il server MCP {server} ha descrizioni di strumenti sospette",
  "notice.mcp.review.body": "Controlla prima di usare questo server: {details}",
  "notice.security.tightened.title":
    "Impostazioni di sicurezza rafforzate da {device, select, none {un dispositivo} other {{device}}}",
  "notice.security.tightened.body":
    "Questo ha solo ridotto ciò che Psyche può fare, quindi non serviva approvazione. Se non sei stato tu, revoca il dispositivo in Impostazioni → Dispositivi.",
  "notice.codeRun.held.title":
    "Psyche ha trattenuto la configurazione di avvio di un'esecuzione di codice in {repo}",
  "notice.codeRun.held.body":
    "Un comando nella sandbox ha creato {paths}. Le app o il tuo prossimo comando potrebbero eseguirne del codice, quindi Psyche l'ha messo da parte senza eliminarlo. Se l'hai creato tu o i tuoi strumenti, tocca Tieni.",
  "notice.codeRun.changed.title":
    "La configurazione di avvio è cambiata durante un'esecuzione di codice in {repo}",
  "notice.codeRun.changed.body":
    "{paths} è cambiato mentre un comando era in esecuzione nella sandbox. Se non sei stato tu o il tuo editor, controllalo prima di aprire la cartella.",
  "notice.codeRun.partial.title": "{repo} è troppo grande per un controllo completo",
  "notice.codeRun.partial.body":
    "Psyche ha controllato solo le cartelle principali per la configurazione di avvio creata dalle esecuzioni di codice.",
  "notice.codeRun.recreated.title": "La sandbox per {repo} è stata ricreata",
  "notice.codeRun.recreated.body":
    "Le sue cartelle di sola lettura sono cambiate, quindi i server attivi e ciò che era installato fuori dal repository non ci sono più. Riavvia ciò che ti serve.",
  "notice.action.keepIt": "Tieni",
  "notice.codeRun.incident.title":
    "Psyche ha trattenuto qualcosa che forse non viene da un'esecuzione di codice in {repo}",
  "notice.codeRun.incident.body":
    "Mentre {paths} veniva messo da parte, una cartella lungo il percorso è cambiata, quindi ciò che è stato spostato potrebbe venire da altrove. È conservato in {place}. Controllalo prima di toccare Tieni, che lo mette in {paths} dentro {repo}.",
  "notice.codeRun.unmoved.title":
    "La configurazione di avvio di un'esecuzione di codice in {repo} è ancora al suo posto",
  "notice.codeRun.unmoved.body":
    "Un comando nella sandbox ha creato {paths} e Psyche non è riuscito a metterlo da parte, quindi non è trattenuto. Le app o il tuo prossimo comando potrebbero eseguirne del codice. Eliminalo prima di aprire la cartella o di eseguirci qualcosa. Non cambiarne prima i permessi per guardarci dentro: così potrebbe essere eseguito.",
  "notice.codeRun.unchecked.title":
    "Psyche non è riuscito a controllare una parte di {repo} dopo un'esecuzione di codice",
  "notice.codeRun.unchecked.body":
    "{paths} è cambiato mentre Psyche lo controllava dopo un comando nella sandbox, quindi al suo interno non è stato controllato nulla in cerca di configurazione di avvio. Se non l'hai cambiato tu o i tuoi strumenti, guardalo prima di aprire la cartella o di eseguirci qualcosa.",
  "notice.machine.added.title": "{name} è stato aggiunto come computer che Psyche può usare",
  "notice.machine.added.body":
    "Psyche può usare il suo schermo, le app, la shell e i file, e ogni azione lì chiede prima a te. Se non l'hai aggiunto tu, rimuovilo in Impostazioni → Dispositivi.",
  "notice.machine.removed.title": "{name} si è rimosso da solo",
  "notice.machine.removed.body":
    "Era un computer che Psyche poteva usare. Psyche non lo userà più finché non lo aggiungi di nuovo.",
};
