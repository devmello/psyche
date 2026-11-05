import type { Catalogue } from "../../index.ts";

/** `personData.*` strings (it); merged into `../it.ts`. */
export const personDataRest: Partial<Catalogue> = {
  "personData.export": "Esporta tutto…",
  "personData.said": "Dimentica ciò che ha detto…",
  "personData.exclude": "Non imparare nulla su di lui/lei…",
  "personData.excludeForget": "Non imparare su di lui/lei e dimentica…",
  "personData.title.said": "Dimenticare ciò che ha detto {name}?",
  "personData.title.exclude": "Smettere di imparare su {name}?",
  "personData.title.exclude_forget": "Smettere di imparare su {name} e dimenticare?",
  "personData.counts": "Vengono eliminati {facts, number} fatti e {quotes, number} citazioni ricavati dai suoi messaggi, e {held, number} elementi trattenuti.",
  "personData.excludeOnly": "I suoi messaggi non verranno letti e non si imparerà nulla su di lui/lei. Ciò che è già noto resta finché non lo dimentichi.",
  "personData.after.said": "La persona, i suoi messaggi e tutto ciò che hai aggiunto tu restano.",
  "personData.after.exclude": "Puoi riconsentirlo in Impostazioni → Memoria → Privacy.",
  "personData.after.exclude_forget": "Puoi riconsentirlo in Impostazioni → Memoria → Privacy, ma ciò che è stato eliminato non torna.",
  "personData.confirm.said": "Dimentica ciò che ha detto",
  "personData.confirm.exclude": "Smetti di imparare",
  "personData.confirm.exclude_forget": "Smetti e dimentica",
  "personData.done.said": "Ho dimenticato ciò che ha detto {name}.",
  "personData.done.exclude": "Non si impara più su {name}.",
  "personData.done.exclude_forget": "Non si impara più su {name} e ciò che ha detto è stato dimenticato.",
};
