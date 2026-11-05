import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (pt); merged into `../pt.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "Acesso à tela e à entrada",
  "settings.computerUse.linux.screen.allowed": "Permitido até você revogar",
  "settings.computerUse.linux.screen.asks": "Pergunta na primeira vez que você usar",
  "settings.computerUse.linux.screen.notNeeded": "Não é necessário no X11",
  "settings.computerUse.linux.screen.unavailable": "Indisponível",
  "settings.computerUse.linux.screen.why":
    "{persona} vê sua tela e usa o mouse e o teclado pela caixa de permissão da sua área de trabalho. Você aprova uma única vez.",
  "settings.computerUse.linux.revoke": "Revogar",
  "settings.computerUse.linux.revokeLabel": "Revogar o acesso à tela e à entrada",
  "settings.computerUse.linux.warning.x11":
    "No X11, qualquer app pode ler sua tela e suas teclas digitadas, inclusive sua senha quando você aprova algo.",
  "settings.computerUse.linux.warning.wlroots":
    "Nesta área de trabalho, qualquer app pode ler sua tela e digitar por você sem perguntar. O Psyche não pode adicionar uma etapa de consentimento.",
  "settings.computerUse.linux.accessibility":
    "Os apps abertos a partir de agora expõem sua estrutura ao Psyche. Os que já estão abertos podem precisar ser reiniciados.",
  "settings.computerUse.linux.headless":
    "É preciso uma sessão gráfica neste computador. Entre na área de trabalho e tente de novo.",
};
