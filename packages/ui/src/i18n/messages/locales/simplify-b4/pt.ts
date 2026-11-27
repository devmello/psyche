import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (pt); merged into `../pt.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "Dispositivos",
  "simplify.b4.devices.description": "Os computadores e iPhones que podem usar o Psyche.",
  "simplify.b4.devices.details": "Detalhes",
  "simplify.b4.devices.canDo": "O que ele pode fazer",
  "simplify.b4.devices.canDoOf": "O que {name} pode fazer",
  "simplify.b4.devices.hostKey": "Chave deste computador: {fingerprint}",
  "simplify.b4.devices.helpers": "Auxiliares",
  "simplify.b4.devices.helpersHint":
    "Os pequenos apps que permitem ao Psyche trabalhar num computador.",
  "simplify.b4.devices.noHelpers":
    "Ainda não há auxiliares. Um auxiliar aparece aqui quando o Psyche roda num computador.",
  "simplify.b4.server.title": "Rede e acesso remoto",
  "simplify.b4.server.description":
    "Como outros dispositivos chegam a este computador e como usar o Psyche fora de casa.",
  "simplify.b4.server.away": "Usar fora de casa",
  "simplify.b4.pairIphone.title": "Parear iPhone",
  "simplify.b4.pairIphone.description":
    "Escaneie um código com o Psyche no seu iPhone. O iPhone e este computador precisam estar no mesmo Wi-Fi.",
  "simplify.b4.pairIphone.button": "Parear iPhone",
  "simplify.b4.pairIphone.scan":
    "Abra o Psyche no seu iPhone e escaneie este código. Ele funciona uma única vez.",
  "simplify.b4.pairIphone.lanOn":
    "O pareamento ativou o acesso pela rede, para o seu iPhone encontrar este computador.",
  "simplify.b4.pairIphone.lanOff": "O acesso pela rede foi desativado de novo.",
  "simplify.b4.pairIphone.turnOff": "Desativar o acesso pela rede",
  "simplify.b4.pairIphone.enableFailed": "Não foi possível ativar o acesso pela rede: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "Não foi possível desativar o acesso pela rede: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "Este computador não pode ser alcançado na sua rede agora. Confira se o Wi-Fi está ligado e tente de novo.",
};
