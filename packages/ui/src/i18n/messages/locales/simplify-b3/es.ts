import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (es); merged into `../es.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "Empezar a chatear",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "No se puede conectar con Psyche ahora mismo. Esta ventana se reconecta sola.",
  "onboarding.done.helperWait":
    "Psyche Helper aún no se ha conectado. El control del ordenador y las notificaciones empiezan cuando lo haga.",
  "onboarding.connectors.searchable": "Hacer que se pueda buscar",
  "onboarding.connectors.searchableHint":
    "{name} puede encontrar correo, eventos y notas de estas cuentas en Búsqueda. Puedes desactivar cualquiera en Ajustes.",
  "home.recoveryKey.title": "Guarda tu clave de recuperación",
  "home.recoveryKey.body":
    "Es la única forma de volver a tu bóveda tras una restauración o si pierdes la clave. Muéstrala, guarda una copia en un lugar seguro y confirma.",
  "settings.credentials.vault.recoveryKey.show": "Mostrar clave de recuperación",
  "settings.credentials.vault.recoveryKey.hide": "Ocultar",
  "settings.credentials.vault.recoveryKey.gone":
    "La clave de recuperación de esta bóveda solo se mostró al crearla, así que no se puede volver a mostrar.",
  "settings.credentials.vault.recoveryKey.failed":
    "No se pudo mostrar la clave de recuperación: {reason}",
  "settings.credentials.vault.recoveryKey.title": "Clave de recuperación",
  "settings.credentials.vault.recoveryKey.body":
    "La única forma de volver a la bóveda tras una restauración o si pierdes la clave. Guarda una copia en un lugar seguro.",
};
