import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (fr); merged into `../fr.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "Expire à {time}",
  "simplifyB9.execHost.sandboxed": "S’exécute dans le bac à sable.",
  "simplifyB9.execHost.noSandbox":
    "Le bac à sable n’est pas configuré, donc cette commande ne peut s’exécuter que sans lui. Configurez-le, ou exécutez-la une fois sans bac à sable.",
  "simplifyB9.execHost.noHostSandbox":
    "Cet ordinateur n’a pas de bac à sable pour les commandes, donc cette commande ne peut s’exécuter que sans lui. Vous pouvez l’exécuter cette fois.",
  "simplifyB9.execHost.runOnce": "Exécuter une fois sans le bac à sable",
  "simplifyB9.library.madeBy": "Créé par {name}",
  "simplifyB9.library.task": "Tâche",
  "simplifyB9.library.more": "Plus de filtres",
};
