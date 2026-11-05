import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (it); merged into `../it.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "Per approvare serve la tua password o una passkey.",
  "blocks.approval.password.waiting":
    "Digita la tua password nella finestra di dialogo del sistema per approvare {code}",
  "blocks.approval.password.waitingShort": "In attesa della tua password…",
  "blocks.approval.password.onceOnly":
    "Le approvazioni con password da questa finestra valgono una sola volta.",
  "blocks.approval.status.allowedOncePassword":
    "Consentito una volta (le approvazioni con password da questa finestra valgono una sola volta)",
  "blocks.approval.password.noUnsandboxed":
    "Eseguire un comando senza sandbox non si può approvare con la password da questa finestra. Configura invece la sandbox",
  "blocks.approval.password.cancelled":
    "La finestra della password è stata annullata, quindi non è stato approvato nulla",
  "blocks.approval.password.failed":
    "La password non è stata accettata, quindi non è stato approvato nulla. Riprova.",
  "blocks.approval.password.unavailableHere":
    "Approva da questo computer, oppure con una passkey da un altro dispositivo.",
  "blocks.approval.password.agentMissing":
    "Su questo desktop non è disponibile una finestra per la password. Installa un agente polkit come polkit-gnome o lxpolkit, oppure usa una passkey.",
  "blocks.approval.password.policyMissing":
    "La policy della password di Psyche non è installata su questo computer. Esegui la configurazione una tantum di Psyche, oppure usa una passkey.",
  "blocks.approval.password.notEnforced":
    "Una regola polkit su questo computer approva Psyche senza password, quindi non può confermare che sia stato tu. Rimuovi la regola, oppure usa una passkey.",
  "blocks.approval.password.unreachable":
    "Il servizio password del sistema non è disponibile. Riprova, oppure usa una passkey.",
  "settings.devices.password.title": "Approvazioni con password",
  "settings.devices.password.description":
    "Prima di approvare un'azione sensibile, Psyche chiede la tua password nella finestra di dialogo del sistema. La password non arriva mai a Psyche.",
  "settings.devices.password.state.ready": "Pronto",
  "settings.devices.password.state.policyMissing": "Policy non installata",
  "settings.devices.password.state.notEnforced": "Disattivato",
  "settings.devices.password.state.noSession": "Nessuna sessione desktop",
  "settings.devices.password.state.agentMissing": "Nessuna finestra password",
  "settings.devices.password.state.unavailable": "Non disponibile",
  "settings.devices.password.detail.ready":
    "Psyche chiede la tua password nella finestra di dialogo del sistema quando approvi un'azione sensibile.",
  "settings.devices.password.detail.policyMissing":
    "La policy della password di Psyche non è installata su questo computer. Esegui la configurazione una tantum di Psyche.",
  "settings.devices.password.detail.notEnforced":
    "Una regola polkit su questo computer approva Psyche senza password. Le approvazioni con password restano disattivate finché non viene rimossa.",
  "settings.devices.password.detail.noSession":
    "Le approvazioni con password richiedono una sessione desktop attiva su questo computer. Apri Psyche lì.",
  "settings.devices.password.detail.agentMissing":
    "Su questo desktop non è disponibile una finestra per la password. Installa un agente polkit come polkit-gnome o lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "Psyche non è riuscito a raggiungere il servizio password del sistema.",
  "settings.devices.password.x11Warning":
    "Questa è una sessione X11. Altri programmi possono leggere ciò che digiti qui, quindi una password è un rallentamento, non un confine. Una sessione Wayland è più sicura.",
};
