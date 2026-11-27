import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (pt); merged into `../pt.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "Começar a conversar",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "Não foi possível falar com a Psyche agora. Esta janela volta a ligar-se sozinha.",
  "onboarding.done.helperWait":
    "O Psyche Helper ainda não se ligou. O controlo do computador e as notificações começam assim que ele se ligar.",
  "onboarding.connectors.searchable": "Tornar pesquisáveis",
  "onboarding.connectors.searchableHint":
    "{name} pode encontrar e-mails, eventos e notas destas contas na Pesquisa. Pode desativar qualquer uma nas Definições.",
  "home.recoveryKey.title": "Guarde a sua chave de recuperação",
  "home.recoveryKey.body":
    "É a única forma de voltar ao seu cofre depois de uma restauração ou se perder a chave. Mostre-a, guarde uma cópia num local seguro e confirme.",
  "settings.credentials.vault.recoveryKey.show": "Mostrar chave de recuperação",
  "settings.credentials.vault.recoveryKey.hide": "Ocultar",
  "settings.credentials.vault.recoveryKey.gone":
    "A chave de recuperação deste cofre só foi mostrada quando o cofre foi criado, por isso não pode ser mostrada de novo.",
  "settings.credentials.vault.recoveryKey.failed":
    "Não foi possível mostrar a chave de recuperação: {reason}",
  "settings.credentials.vault.recoveryKey.title": "Chave de recuperação",
  "settings.credentials.vault.recoveryKey.body":
    "A única forma de voltar ao cofre depois de uma restauração ou se perder a chave. Guarde uma cópia num local seguro.",
};
