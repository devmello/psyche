import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (pt); merged into `../pt.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "Expira às {time}",
  "simplifyB9.execHost.sandboxed": "É executado na sandbox.",
  "simplifyB9.execHost.noSandbox":
    "A sandbox não está configurada, então este comando só pode ser executado sem ela. Configure-a ou execute-o uma vez sem a sandbox.",
  "simplifyB9.execHost.noHostSandbox":
    "Este computador não tem sandbox para comandos, então este comando só pode ser executado sem ela. Você pode executá-lo só desta vez.",
  "simplifyB9.execHost.runOnce": "Executar uma vez sem a sandbox",
  "simplifyB9.library.madeBy": "Feito por {name}",
  "simplifyB9.library.task": "Tarefa",
  "simplifyB9.library.more": "Mais filtros",
};
