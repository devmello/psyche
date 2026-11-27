import type { Catalogue } from "../../index.ts";

/** Privacy, Browser and About simplified copy (pt); merged into `../pt.ts`. */
export const simplifyB7: Partial<Catalogue> = {
  "simplify.b7.about.doctorDescription":
    "Verifica se o Psyche, a sandbox, as permissões e o cofre estão funcionando.",
  "simplify.b7.doctor.psyche": "Psyche",
  "simplify.b7.browser.fromSetup":
    "Definido pela sua configuração, então não pode ser alterado aqui.",
  "simplify.b7.browser.advancedHint":
    "Perfil do Chrome, logins de outros navegadores, gravações e portas de pré-visualização",
  "simplify.b7.permissions.advancedHint": "Revisão de comandos no modo Auto",
  "simplify.b7.updates.off":
    "As atualizações estão desativadas nesta versão. Para atualizar, recompile o Psyche e execute pnpm app:install.",
};
