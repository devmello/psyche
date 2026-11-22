import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (it); merged into `../it.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "Psyche ha annullato una modifica ai suoi dati di sicurezza fatta fuori dall’app.",
  "web.security.banner.untrusted":
    "Il controllo dei dati di sicurezza di Psyche non è riuscito. Le modifiche che ampliano l’accesso sono bloccate.",
  "web.security.banner.recovery":
    "{count, plural, one {Una modifica di sicurezza richiesta su questo Mac si applica il {when}, a meno che tu non la annulli.} other {# modifiche di sicurezza richieste su questo Mac sono in attesa. La prossima si applica il {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {1 avviso di sicurezza da controllare.} other {# avvisi di sicurezza da controllare.}}",
  "web.security.review": "Controlla",
  "web.security.hide": "Nascondi",
  "web.security.panel.label": "Dati di sicurezza",
  "web.security.alert.changed":
    "Un programma su questo Mac ha modificato {count, plural, one {1 dato di sicurezza} other {# dati di sicurezza}} senza passare da Psyche. Psyche {count, plural, one {l’ha ripristinato} other {li ha ripristinati}}. Se non sei stato tu, controlla il Mac per software indesiderato.",
  "web.security.alert.untrusted":
    "Il controllo dei dati di sicurezza di Psyche non è riuscito. Nuovi dispositivi, impostazioni di sicurezza e approvazioni con Touch ID sono bloccati. Controlla i tuoi dispositivi, poi esegui psyched security reseal sul Mac; si applica dopo 24 ore.",
  "web.security.alert.firstSeal":
    "Psyche ora controlla i suoi dati di sicurezza ({devices, plural, one {1 dispositivo abbinato} other {# dispositivi abbinati}}). Una modifica fatta fuori da Psyche viene annullata e mostrata qui. Controlla i tuoi dispositivi una volta.",
  "web.security.alert.resealed": "Psyche ha sigillato di nuovo i suoi dati di sicurezza.",
  "web.security.alert.restored":
    "Psyche è partito da un backup ripristinato e ha sigillato i suoi dati di sicurezza così come sono. Se non hai ripristinato un backup, controlla i tuoi dispositivi.",
  "web.security.alert.firstAdmin":
    "Un comando su questo Mac ha reso {name} il primo dispositivo amministratore. Se non sei stato tu, revocalo in Dispositivi.",
  "web.security.alert.requested": "Richiesto su questo Mac: {action} Si applica il {when}.",
  "web.security.alert.applied": "Applicato: {action}",
  "web.security.alert.cancelled": "Annullato: {action}",
  "web.security.alert.failed": "Impossibile applicare: {action}",
  "web.security.op.devicesApprove": "approvare il dispositivo {name}.",
  "web.security.op.devicesGrant": "cambiare cosa può fare {name}.",
  "web.security.op.presenceReset":
    "non chiedere più Touch ID o una passkey per le modifiche di sicurezza finché non viene registrata una nuova chiave.",
  "web.security.op.sealReset": "accettare i dati di sicurezza attuali così come sono.",
  "web.security.device": "un dispositivo",
  "web.security.deviceKey": "{name} (chiave {fingerprint})",
  "web.security.change":
    "{change, select, added {Aggiunto} modified {Modificato} other {Rimosso}}: {what}",
  "web.security.more": "{count, plural, one {e 1 altro} other {e altri #}}",
  "web.security.ack": "Segna come controllato",
  "web.security.approveNow": "Approva ora",
  "web.security.cancel": "Annulla richiesta",
  "web.security.needsApproval":
    "Approva la scheda con Touch ID o una passkey, poi premi di nuovo il pulsante.",
  "web.security.failed": "Non ha funzionato: {message}",
};
