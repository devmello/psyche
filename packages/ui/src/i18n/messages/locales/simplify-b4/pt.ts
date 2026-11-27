import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (pt); merged into `../pt.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "Dispositivos",
  "simplifyB4.devices.description": "Os computadores e iPhones que podem usar o Psyche.",
  "simplifyB4.devices.details": "Detalhes",
  "simplifyB4.devices.canDo": "O que ele pode fazer",
  "simplifyB4.devices.canDoOf": "O que {name} pode fazer",
  "simplifyB4.devices.hostKey": "Chave deste computador: {fingerprint}",
  "simplifyB4.devices.helpers": "Auxiliares",
  "simplifyB4.devices.helpersHint": "Os pequenos apps que permitem ao Psyche trabalhar num computador.",
  "simplifyB4.devices.noHelpers": "Ainda não há auxiliares. Um auxiliar aparece aqui quando o Psyche roda num computador.",
  "simplifyB4.server.title": "Rede e acesso remoto",
  "simplifyB4.server.description": "Como outros dispositivos chegam a este computador e como usar o Psyche fora de casa.",
  "simplifyB4.server.away": "Usar fora de casa",
  "simplifyB4.pairIphone.title": "Parear iPhone",
  "simplifyB4.pairIphone.description": "Escaneie um código com o Psyche no seu iPhone. O iPhone e este computador precisam estar no mesmo Wi-Fi.",
  "simplifyB4.pairIphone.button": "Parear iPhone",
  "simplifyB4.pairIphone.scan": "Abra o Psyche no seu iPhone e escaneie este código. Ele funciona uma única vez.",
  "simplifyB4.pairIphone.lanOn": "O pareamento ativou o acesso pela rede, para o seu iPhone encontrar este computador.",
  "simplifyB4.pairIphone.lanOff": "O acesso pela rede foi desativado de novo.",
  "simplifyB4.pairIphone.turnOff": "Desativar o acesso pela rede",
  "simplifyB4.pairIphone.enableFailed": "Não foi possível ativar o acesso pela rede: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "Não foi possível desativar o acesso pela rede: {reason}",
  "simplifyB4.pairIphone.noNetwork": "Este computador não pode ser alcançado na sua rede agora. Confira se o Wi-Fi está ligado e tente de novo.",
};
