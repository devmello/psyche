import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (it); merged into `../it.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "Scade alle {time}",
  "simplify.b9.execHost.sandboxed": "Viene eseguito nella sandbox.",
  "simplify.b9.execHost.noSandbox":
    "La sandbox non è configurata, quindi questo comando può essere eseguito solo senza. Configurala oppure eseguilo una volta senza sandbox.",
  "simplify.b9.execHost.noHostSandbox":
    "Su questo computer non c’è una sandbox per i comandi, quindi questo comando può essere eseguito solo senza. Puoi eseguirlo solo questa volta.",
  "simplify.b9.execHost.runOnce": "Esegui una volta senza la sandbox",
  "simplify.b9.library.madeBy": "Creato da {name}",
  "simplify.b9.library.task": "Attività",
  "simplify.b9.library.more": "Altri filtri",
};
