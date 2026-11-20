import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (es); merged into `../es.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Mantener este equipo activo",
  "settings.daily.keepAwake.hint":
    "Mientras se ejecuta una tarea programada, este equipo no se suspende hasta que termine. La pantalla sí puede apagarse.",
  "settings.key.scheduled.keepAwake":
    "Mantener este equipo activo mientras se ejecutan tareas programadas",
  "scheduled.history.retryingAt": "Reintento a las {time}",
  "scheduled.history.retry": "Reintento {n} de 3",
  "scheduled.history.failedAfterRetries": "Falló tras {n} reintentos",
};
