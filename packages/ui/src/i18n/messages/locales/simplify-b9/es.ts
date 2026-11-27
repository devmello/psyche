import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (es); merged into `../es.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "Caduca a las {time}",
  "simplify.b9.execHost.sandboxed": "Se ejecuta en el entorno aislado.",
  "simplify.b9.execHost.noSandbox":
    "El entorno aislado no está configurado, así que este comando solo puede ejecutarse sin él. Configúralo o ejecútalo una vez sin el entorno aislado.",
  "simplify.b9.execHost.noHostSandbox":
    "Este equipo no tiene entorno aislado para comandos, así que este comando solo puede ejecutarse sin él. Puedes ejecutarlo solo esta vez.",
  "simplify.b9.execHost.runOnce": "Ejecutar una vez sin el entorno aislado",
  "simplify.b9.library.madeBy": "Hecho por {name}",
  "simplify.b9.library.task": "Tarea",
  "simplify.b9.library.more": "Más filtros",
};
