import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (es); merged into `../es.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "Escritorio separado",
  "settings.separateDesktop.description":
    "Un escritorio privado en un contenedor, con sus propias apps y archivos. Solo ve las carpetas que compartes para una tarea, no tiene internet salvo que lo permitas para esa tarea y se detiene cuando la tarea termina.",
  "settings.separateDesktop.state.off": "Detenido",
  "settings.separateDesktop.state.starting": "Iniciando",
  "settings.separateDesktop.state.running": "En marcha",
  "settings.separateDesktop.state.stopping": "Deteniéndose",
  "settings.separateDesktop.state.failed": "No se pudo iniciar",
  "settings.separateDesktop.engine": "Motor de contenedores: {engine}",
  "settings.separateDesktop.rootful":
    "Este motor de contenedores se ejecuta como root. Usa Podman sin root para el escritorio separado.",
  "settings.separateDesktop.memory": "Límite de memoria",
  "settings.separateDesktop.memoryHint":
    "La máxima memoria que puede usar el escritorio separado mientras funciona.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "Carpetas compartidas: {names}",
  "settings.separateDesktop.internet": "Internet está activado para esta tarea",
  "settings.separateDesktop.reset": "Restablecer el escritorio separado",
  "settings.separateDesktop.resetHint":
    "Elimina su contenedor y todo lo guardado dentro. Las carpetas que compartiste no se tocan.",
};
