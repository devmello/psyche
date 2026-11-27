import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (it); merged into `../it.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "Dispositivi",
  "simplify.b4.devices.description": "I computer e gli iPhone che possono usare Psyche.",
  "simplify.b4.devices.details": "Dettagli",
  "simplify.b4.devices.canDo": "Cosa può fare",
  "simplify.b4.devices.canDoOf": "Cosa può fare {name}",
  "simplify.b4.devices.hostKey": "Chiave di questo computer: {fingerprint}",
  "simplify.b4.devices.helpers": "Assistenti",
  "simplify.b4.devices.helpersHint":
    "Le piccole app che permettono a Psyche di lavorare su un computer.",
  "simplify.b4.devices.noHelpers":
    "Ancora nessun assistente. Un assistente compare qui quando Psyche è in esecuzione su un computer.",
  "simplify.b4.server.title": "Rete e accesso remoto",
  "simplify.b4.server.description":
    "Come gli altri dispositivi raggiungono questo computer e come usare Psyche fuori casa.",
  "simplify.b4.server.away": "Usalo fuori casa",
  "simplify.b4.pairIphone.title": "Abbina iPhone",
  "simplify.b4.pairIphone.description":
    "Scansiona un codice con Psyche sul tuo iPhone. iPhone e computer devono essere sulla stessa rete Wi-Fi.",
  "simplify.b4.pairIphone.button": "Abbina iPhone",
  "simplify.b4.pairIphone.scan":
    "Apri Psyche sul tuo iPhone e scansiona questo codice. Funziona una sola volta.",
  "simplify.b4.pairIphone.lanOn":
    "L’abbinamento ha attivato l’accesso di rete, così il tuo iPhone può trovare questo computer.",
  "simplify.b4.pairIphone.lanOff": "L’accesso di rete è di nuovo disattivato.",
  "simplify.b4.pairIphone.turnOff": "Disattiva l’accesso di rete",
  "simplify.b4.pairIphone.enableFailed": "Impossibile attivare l’accesso di rete: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "Impossibile disattivare l’accesso di rete: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "Al momento questo computer non è raggiungibile sulla tua rete. Controlla che il Wi-Fi sia attivo e riprova.",
};
