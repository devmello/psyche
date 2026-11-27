import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (it); merged into `../it.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "Scade alle {time}",
  "simplifyB9.execHost.sandboxed": "Viene eseguito nella sandbox.",
  "simplifyB9.execHost.noSandbox":
    "La sandbox non è configurata, quindi questo comando può essere eseguito solo senza. Configurala oppure eseguilo una volta senza sandbox.",
  "simplifyB9.execHost.noHostSandbox":
    "Su questo computer non c’è una sandbox per i comandi, quindi questo comando può essere eseguito solo senza. Puoi eseguirlo solo questa volta.",
  "simplifyB9.execHost.runOnce": "Esegui una volta senza la sandbox",
  "simplifyB9.library.madeBy": "Creato da {name}",
  "simplifyB9.library.task": "Attività",
  "simplifyB9.library.more": "Altri filtri",
};
