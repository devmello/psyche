import type { Catalogue } from "../../index.ts";

/** App update strings (es); merged into `../es.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} está listo",
  "shell.update.readyRequired": "Psyche {version} está listo. Esta actualización es obligatoria.",
  "shell.update.restart": "Reiniciar para actualizar",
  "shell.update.dismiss": "Ocultar aviso de actualización",
  "settings.updates.status": "Estado",
  "settings.updates.checking": "Buscando actualizaciones…",
  "settings.updates.upToDate": "Actualizado",
  "settings.updates.ready": "Psyche {version} está listo",
  "settings.updates.readyRequired": "Psyche {version} está listo (obligatoria)",
  "settings.updates.refused": "Actualización rechazada: {reason}",
  "settings.updates.installFailed":
    "Psyche no pudo instalar la actualización. Inténtalo de nuevo más tarde.",
};
