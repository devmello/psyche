import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (es); merged into `../es.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "No se pudieron exportar los datos de esta persona ({reason}).",
  "actionError.revokeGrant": "No se pudo revocar esta aprobación ({reason}). Sigue vigente.",
  "actionError.reindex": "No se pudo reconstruir el índice de búsqueda ({reason}).",
  "actionError.rerun": "No se pudo volver a ejecutar esta automatización ({reason}).",
  "actionError.stopResearch": "No se pudo detener la investigación ({reason}). Sigue en curso.",
  "actionError.unmute": "No se pudieron volver a activar los avisos ({reason}).",
  "actionError.language": "No se pudo cambiar el idioma ({reason}).",
  "actionError.transcriptMode": "No se pudo cambiar el detalle de la transcripción ({reason}).",
  "actionError.screenAskDestination":
    "No se pudo cambiar el destino de las preguntas de pantalla ({reason}).",
  "actionError.takeOver": "No se pudo tomar el control de la pantalla virtual ({reason}).",
};
