import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (es); merged into `../es.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Comprobación del asistente de Linux",
  "settings.devices.helperCheck.description":
    "Cuando el asistente de Linux se conecta, Psyche comprueba qué programa es en realidad.",
  "settings.devices.helperCheck.state.verified": "Verificado: asistente instalado en el sistema",
  "settings.devices.helperCheck.state.userOwned": "Sin verificar: asistente de tu carpeta personal",
  "settings.devices.helperCheck.state.unverified":
    "Sin verificar: Psyche no pudo comprobar el asistente",
  "settings.devices.helperCheck.detail.verified":
    "Es el asistente instalado con Psyche. Solo el sistema puede cambiarlo.",
  "settings.devices.helperCheck.detail.userOwned":
    "Se ejecuta desde archivos tuyos, como un AppImage o una compilación en tu carpeta personal. Psyche lo acepta, pero no puede descartar que otro programa tuyo lo haya sustituido.",
  "settings.devices.helperCheck.detail.unverified":
    "Psyche lo acepta por ahora, pero no pudo saber de qué programa se trata.",
  "settings.devices.helperCheck.refused": "Rechazado: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche no pudo verificar el asistente",
  "settings.devices.helperCheck.reason.notHelper": "este programa no es el asistente de Psyche",
  "settings.devices.helperCheck.reason.userCopy":
    "es una copia fuera de la instalación del sistema y se exige el asistente instalado",
  "settings.devices.helperCheck.reason.loaderEnv":
    "se inició con una ruta de bibliotecas o una biblioteca precargada",
  "settings.devices.helperCheck.reason.foreignCode": "tiene código cargado desde fuera del sistema",
  "settings.devices.helperCheck.reason.severalPrograms": "más de un programa comparte su conexión",
  "settings.devices.helperCheck.reason.handedOver": "otro programa le entregó su conexión",
  "settings.devices.helperCheck.reason.stillStarting": "aún se estaba iniciando",
  "settings.devices.helperCheck.reason.debugged": "está detenido o en depuración",
  "settings.devices.helperCheck.reason.restartNeeded":
    "fue sustituido o se actualizó una biblioteca del sistema desde que arrancó; reinicia el asistente",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "alguien distinto del sistema podría cambiar sus archivos",
  "settings.devices.helperCheck.reason.otherNamespace":
    "se ejecuta en un entorno aislado aparte de este equipo",
  "settings.devices.helperCheck.reason.busy":
    "Psyche estaba ocupado comprobando otras conexiones; el asistente lo intentará de nuevo",
  "settings.devices.nodeKind.hostHelper": "Asistente de este equipo",
  "settings.devices.nodeKind.guest": "Escritorio aparte",
};
