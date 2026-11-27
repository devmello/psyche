import type { Catalogue } from "../../index.ts";

/** Privacy, Browser and About simplified copy (fr); merged into `../fr.ts`. */
export const simplifyB7: Partial<Catalogue> = {
  "simplify.b7.about.doctorDescription":
    "Vérifie que Psyche, le bac à sable, les autorisations et le coffre fonctionnent.",
  "simplify.b7.doctor.psyche": "Psyche",
  "simplify.b7.browser.fromSetup": "Défini par votre configuration, donc non modifiable ici.",
  "simplify.b7.browser.advancedHint":
    "Profil Chrome, connexions d'autres navigateurs, enregistrements et ports d'aperçu",
  "simplify.b7.permissions.advancedHint": "Vérification des commandes en mode Auto",
  "simplify.b7.updates.off":
    "Les mises à jour sont désactivées pour cette version. Pour mettre à jour, recompilez Psyche et lancez pnpm app:install.",
};
