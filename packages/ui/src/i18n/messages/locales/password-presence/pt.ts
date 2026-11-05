import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (pt); merged into `../pt.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "Precisa da sua senha ou de uma passkey para aprovar.",
  "blocks.approval.password.waiting":
    "Digite sua senha na caixa de diálogo do sistema para aprovar {code}",
  "blocks.approval.password.waitingShort": "Aguardando sua senha…",
  "blocks.approval.password.onceOnly":
    "Aprovações com senha a partir desta janela valem apenas uma vez.",
  "blocks.approval.status.allowedOncePassword":
    "Permitido uma vez (aprovações com senha a partir desta janela valem apenas uma vez)",
  "blocks.approval.password.noUnsandboxed":
    "Executar um comando sem o sandbox não pode ser aprovado com senha a partir desta janela. Configure o sandbox em vez disso",
  "blocks.approval.password.cancelled":
    "A caixa de diálogo da senha foi cancelada, então nada foi aprovado",
  "blocks.approval.password.failed":
    "A senha não foi aceita, então nada foi aprovado. Tente novamente.",
  "blocks.approval.password.unavailableHere":
    "Aprove neste computador ou com uma passkey de outro dispositivo.",
  "blocks.approval.password.agentMissing":
    "Este desktop não tem uma caixa de diálogo de senha. Instale um agente polkit, como polkit-gnome ou lxpolkit, ou use uma passkey.",
  "blocks.approval.password.policyMissing":
    "A política de senha do Psyche não está instalada neste computador. Execute a configuração única do Psyche ou use uma passkey.",
  "blocks.approval.password.notEnforced":
    "Uma regra do polkit neste computador aprova o Psyche sem senha, então não é possível confirmar que foi você. Remova a regra ou use uma passkey.",
  "blocks.approval.password.unreachable":
    "O serviço de senha do sistema não está disponível. Tente novamente ou use uma passkey.",
  "settings.devices.password.title": "Aprovações com senha",
  "settings.devices.password.description":
    "Antes de aprovar uma ação sensível, o Psyche pede sua senha na caixa de diálogo do próprio sistema. A senha nunca chega ao Psyche.",
  "settings.devices.password.state.ready": "Pronto",
  "settings.devices.password.state.policyMissing": "Política não instalada",
  "settings.devices.password.state.notEnforced": "Desativado",
  "settings.devices.password.state.noSession": "Sem sessão de desktop",
  "settings.devices.password.state.agentMissing": "Sem caixa de senha",
  "settings.devices.password.state.unavailable": "Indisponível",
  "settings.devices.password.detail.ready":
    "O Psyche pede sua senha na caixa de diálogo do sistema quando você aprova uma ação sensível.",
  "settings.devices.password.detail.policyMissing":
    "A política de senha do Psyche não está instalada neste computador. Execute a configuração única do Psyche.",
  "settings.devices.password.detail.notEnforced":
    "Uma regra do polkit neste computador aprova o Psyche sem senha. As aprovações com senha ficam desativadas até que ela seja removida.",
  "settings.devices.password.detail.noSession":
    "Aprovações com senha precisam de uma sessão de desktop ativa neste computador. Abra o Psyche lá.",
  "settings.devices.password.detail.agentMissing":
    "Este desktop não tem uma caixa de diálogo de senha. Instale um agente polkit, como polkit-gnome ou lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "O Psyche não conseguiu acessar o serviço de senha do sistema.",
  "settings.devices.password.x11Warning":
    "Esta é uma sessão X11. Outros programas podem ler o que você digita aqui, então uma senha é um obstáculo, não uma barreira. Uma sessão Wayland é mais segura.",
};
