import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (it); merged into `../it.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Tieni sveglio questo computer",
  "settings.daily.keepAwake.hint":
    "Mentre un'attività programmata è in corso, questo computer non va in stop finché non finisce. Lo schermo può comunque spegnersi.",
  "settings.key.scheduled.keepAwake":
    "Tieni sveglio questo computer mentre girano le attività programmate",
  "scheduled.history.retryingAt": "Nuovo tentativo alle {time}",
  "scheduled.history.retry": "Tentativo {n} di 3",
  "scheduled.history.failedAfterRetries": "Non riuscito dopo {n} nuovi tentativi",
  "scheduled.history.cancelRetry": "Annulla nuovo tentativo",
  "scheduled.history.cancelRetry.aria": "Annulla il nuovo tentativo dell'esecuzione di {when}",
  "scheduled.history.cancelRetry.failed": "Impossibile annullare il nuovo tentativo ({reason}).",
  "settings.updates.group": "Aggiornamenti",
  "settings.updates.hint": "Psyche cerca aggiornamenti firmati e li installa quando esci.",
  "settings.updates.channel": "Canale delle versioni",
  "settings.updates.channel.stable": "Stabile",
  "settings.updates.channel.note":
    "Per ora Stabile è l'unico canale. Beta comparirà qui quando saranno pubblicate build beta. Ogni aggiornamento viene comunque verificato con la chiave di rilascio di Psyche.",
  "settings.storage.title": "Spazio di archiviazione",
  "settings.storage.hint":
    "Spazio su disco che Psyche usa nella sua cartella dati su questo computer.",
  "settings.storage.total": "Totale",
  "settings.storage.clear": "Svuota…",
  "settings.storage.cleared": "Svuotato. Liberati {size}.",
  "settings.storage.clearFailed": "Impossibile svuotare l'archiviazione ({reason}).",
  "settings.storage.compact.title": "Compatta il database",
  "settings.storage.compact.hint":
    "Database: {size}, fino a {reclaimable} recuperabili. Psyche si ferma un momento durante l'operazione.",
  "settings.storage.compact.button": "Compatta",
  "settings.storage.compact.running": "Compattazione…",
  "settings.storage.compact.done": "Compattato in {seconds} s, {size} risparmiati.",
  "settings.storage.compact.failed": "Impossibile compattare il database ({reason}).",
  "settings.storage.compact.busy": "Psyche è occupato. Riprova quando ha finito.",
  "settings.storage.failed": "Impossibile leggere l'uso dell'archiviazione ({reason}).",
  "settings.storage.confirm.title": "Svuotare le cache e le vecchie registrazioni?",
  "settings.storage.confirm.body":
    "Verranno eliminati {size} di cache e registrazioni del browser più vecchie di 7 giorni, insieme alle loro voci nella Libreria. Psyche ricostruisce le cache quando servono. Chat, memoria, altri file della Libreria, cassaforte e impostazioni non vengono toccati.",
  "settings.storage.confirm.clear": "Svuota",
  "settings.storage.cat.database": "Database",
  "settings.storage.cat.memoryIndex": "Indice della memoria",
  "settings.storage.cat.library": "Allegati e Libreria",
  "settings.storage.cat.browserProfiles": "Profili del browser",
  "settings.storage.cat.recordings": "Registrazioni",
  "settings.storage.cat.logs": "Log",
  "settings.storage.cat.caches": "Cache",
  "settings.storage.cat.other": "Tutto il resto",
};
