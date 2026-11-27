import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (es); merged into `../es.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "Caduca a las {time}",
  "simplifyB9.execHost.sandboxed": "Se ejecuta en el entorno aislado.",
  "simplifyB9.execHost.noSandbox":
    "El entorno aislado no está configurado, así que este comando solo puede ejecutarse sin él. Configúralo o ejecútalo una vez sin el entorno aislado.",
  "simplifyB9.execHost.noHostSandbox":
    "Este equipo no tiene entorno aislado para comandos, así que este comando solo puede ejecutarse sin él. Puedes ejecutarlo solo esta vez.",
  "simplifyB9.execHost.runOnce": "Ejecutar una vez sin el entorno aislado",
  "simplifyB9.library.madeBy": "Hecho por {name}",
  "simplifyB9.library.task": "Tarea",
  "simplifyB9.library.more": "Más filtros",
};
