import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (pt); merged into `../pt.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "Expira às {time}",
  "simplify.b9.execHost.sandboxed": "É executado na sandbox.",
  "simplify.b9.execHost.noSandbox":
    "A sandbox não está configurada, então este comando só pode ser executado sem ela. Configure-a ou execute-o uma vez sem a sandbox.",
  "simplify.b9.execHost.noHostSandbox":
    "Este computador não tem sandbox para comandos, então este comando só pode ser executado sem ela. Você pode executá-lo só desta vez.",
  "simplify.b9.execHost.runOnce": "Executar uma vez sem a sandbox",
  "simplify.b9.library.madeBy": "Feito por {name}",
  "simplify.b9.library.task": "Tarefa",
  "simplify.b9.library.more": "Mais filtros",
};
