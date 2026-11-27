import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (pt); merged into `../pt.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "neste computador, sem sandbox: aqui não há nenhuma para comandos",
  "blocks.execHost.noHostSandbox":
    "Neste computador não há sandbox para comandos, então este comando só pode rodar sem uma. Digite {word} para executá-lo desta vez.",
  "blocks.execHost.mustTypeOnly": "Digite {word} para permitir.",
  "settings.uninstall.stopSandboxPc":
    "O serviço do PC sandbox é removido. O Windows pede a aprovação de um administrador uma vez.",
  "settings.computerUse.tcc.microphone.name": "Microfone",
  "settings.computerUse.tcc.microphone.why":
    "permite que o Psyche ouça você para ditado e notas de reuniões",
  "settings.sandbox.restart.reopen": "Feche o Psyche e abra de novo.",
  "settings.sandbox.pc.title": "Ativar o PC sandbox",
  "settings.sandbox.pc.body":
    "srt, a sandbox leve do Psyche para comandos, não roda no Windows. Aqui, scripts, servidores de comandos e conectores criados pelo Psyche rodam no Privacidade e segurança → Uso do computador → Modo VM: um pequeno computador Linux próprio, sem acesso aos seus arquivos. Ative em Ajustes → PC sandbox e depois verifique de novo.",
  "settings.sandbox.pc.notReady.title": "O PC sandbox ainda não está pronto",
  "settings.sandbox.pc.notReady.body":
    "Ele está ativado, mas ainda não está rodando, ou o Psyche dentro dele está desatualizado. Inicie ou atualize em Ajustes → Privacidade e segurança → Uso do computador → Modo VM e depois verifique de novo.",
  "settings.sandbox.pc.ready":
    "O PC sandbox está ativado: scripts, servidores de comandos e conectores criados pelo Psyche rodam nele.",
  "settings.sandbox.pc.open": "Abrir os ajustes do PC sandbox",
  "settings.sandbox.pc.where":
    "Fica em Ajustes → Privacidade e segurança → Uso do computador → Modo VM.",
  "settings.devices.platform.windows": "PC com Windows",
  "settings.devices.nodeKind.winHelper": "Helper do Windows",
  "settings.devices.thisPcAdmin":
    "Este PC é o dispositivo administrador. Outro dispositivo administrador pode revogá-lo aqui.",
  "settings.devices.presenceKey.windowsHello":
    "Chave do Windows Hello ({algorithm}), conforme informado pelo helper",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Chave do Windows Hello, conforme informado pelo helper",
  "settings.shortcut.reserved.windowsKey": "Windows (atalhos com a tecla do Windows)",
  "settings.shortcut.reserved.windowMenu": "o menu de janelas",
  "settings.shortcut.reserved.closeApp": "fechar apps",
  "settings.shortcut.reserved.taskManager": "o Gerenciador de Tarefas",
  "settings.shortcut.reserved.startMenu": "o menu Iniciar",
  "settings.shortcut.reserved.securityScreen": "a tela de segurança do Windows",
  "settings.shortcut.key.Super": "Tecla do Windows",
  "settings.shortcut.useDefault": "Usar o padrão",
  "settings.quickEntry.title": "Entrada rápida",
  "settings.key.quickEntry.shortcut": "Atalho",
  "settings.quickEntry.shortcutHint":
    "Abre o chat flutuante de qualquer app. Se você não escolher outras teclas, o Psyche usa {keys}, ou {fallback} quando outro app as está usando.",
  "settings.voice.key.rightCtrl": "Ctrl direito",
  "settings.voice.key.rightAlt": "Alt direito",
  "settings.voice.key.rightShift": "Shift direito",
  "settings.voice.key.rightWin": "Tecla do Windows direita",
  "settings.voice.key.capsLock": "Caps Lock",
  "settings.voice.key.scrollLock": "Scroll Lock",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "Tecla Menu",
  "settings.voice.key.insert": "Insert",
  "settings.voice.key.numLock": "Num Lock",
  "settings.voice.key.other": "Outra tecla",
  "settings.voice.key.press": "Pressione uma tecla",
  "settings.voice.key.pressNow": "Pressione a tecla para segurar…",
  "settings.voice.key.cantUse":
    "Essa tecla digita texto, então não dá para segurá-la para falar. Tente Ctrl direito, Caps Lock, Pause, a tecla Menu ou F13 a F24.",
  "settings.voice.key.capsLockHint":
    "O Caps Lock mantém seu estado de ligado ou desligado: segurá-lo para falar não o muda, e um toque rápido ainda o alterna.",
  "settings.voice.key.altGrWarning":
    "No seu layout de teclado, o Alt direito é AltGr, que digita caracteres como @ ou €. Segurá-lo para falar pode atrapalhar a digitação desses caracteres; o Ctrl direito é mais seguro.",
  "settings.voice.access.windowsWhy":
    "observa a tecla que você segura e digita no app em foco. O Windows não exige permissão para isso; apps executados como administrador não recebem o texto ditado.",
  "settings.voice.model.title": "Modelo de voz",
  "settings.voice.model.usingHelper":
    "O ditado usa o reconhecimento de voz do helper. O modelo de voz transcreve melhor e roda neste Mac.",
  "settings.voice.model.download": "Baixe o modelo de voz ({mb} MB) para um ditado melhor",
  "settings.voice.model.downloadHint":
    "Um download único do projeto whisper.cpp, verificado antes do uso. O áudio nunca sai deste Mac.",
  "settings.voice.model.downloading": "Baixando o modelo de voz: {received} de {total} MB",
  "settings.voice.model.ready": "Whisper ({model}) neste Mac",
  "settings.voice.model.readyHint":
    "O ditado e as gravações são transcritos aqui; o áudio nunca sai do Mac.",
  "settings.voice.model.readyNotFirst":
    "Instalado. Sua ordem de mecanismos coloca outro na frente, então o ditado não o usa agora.",
  "settings.voice.model.failed": "O download falhou: {reason}",
  "settings.voice.model.retry": "Tentar de novo",
  "settings.voice.model.vcredist":
    "O modelo de voz precisa do Microsoft Visual C++ Redistributable. Instale-o e dite de novo.",
  "settings.voice.model.crashed":
    "O mecanismo de voz parou inesperadamente; o ditado usa o helper até ele reiniciar.",
  "settings.sandboxPc.title": "Ativar o PC sandbox",
  "settings.sandboxPc.explain":
    "{persona} recebe um pequeno PC Linux privado que roda dentro do Windows. As tarefas rodam lá em vez de no seu PC, e veem apenas as pastas que você compartilha.",
  "settings.sandboxPc.oneTime":
    "Configuração única: o Windows pede a aprovação de um administrador uma vez, para adicionar um serviço em segundo plano que roda o PC. Depois o Psyche baixa a imagem do PC ({download}, {disk} no disco). Nada mais precisa de administrador.",
  "settings.sandboxPc.oneTimeNoSize":
    "Configuração única: o Windows pede a aprovação de um administrador uma vez, para adicionar um serviço em segundo plano que roda o PC. Depois o Psyche baixa a imagem do PC. Nada mais precisa de administrador.",
  "settings.sandboxPc.turnOn": "Ativar o PC sandbox",
  "settings.sandboxPc.cancelDownload": "Cancelar download",
  "settings.sandboxPc.waitingAdmin": "Aguardando o pedido do administrador…",
  "settings.sandboxPc.restarting": "Finalizando a configuração…",
  "settings.sandboxPc.downloading": "Baixando a imagem do PC: {received} de {total}",
  "settings.sandboxPc.progressLabel": "Download da imagem do PC",
  "settings.sandboxPc.ready": "Configurado",
  "settings.sandboxPc.readyText": "O PC sandbox está configurado. Versão {version}.",
  "settings.sandboxPc.unsupported": "O PC sandbox não está disponível aqui: {reason}.",
  "settings.sandboxPc.failed": "Não foi possível ativar o PC sandbox: {reason}",
  "settings.sandboxPc.failedDid": "Nada mais foi alterado. Você pode tentar de novo.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "PC sandbox",
  "settings.sandboxPc.onboarding": "PC sandbox",
  "settings.sandboxPc.onboardingHint":
    "Opcional: um PC Linux privado para tarefas que não devem mexer nos seus arquivos. Você pode configurar depois nos ajustes.",
  "settings.sandboxPc.update.title": "Atualizar o serviço do PC sandbox",
  "settings.sandboxPc.update.explainCompatible":
    "Esta versão do Psyche traz um serviço de PC sandbox mais novo que o instalado. O PC sandbox continua funcionando como está.",
  "settings.sandboxPc.update.explainRequired":
    "Esta versão do Psyche não consegue usar o serviço de PC sandbox instalado. O PC sandbox fica desligado até você atualizar.",
  "settings.sandboxPc.update.available": "Atualização disponível",
  "settings.sandboxPc.update.required": "Atualização necessária",
  "settings.sandboxPc.update.versions": "Instalada: {installed}. Esta versão do Psyche: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "O Windows pede a aprovação de um administrador uma vez. Um PC sandbox em execução para enquanto o serviço é substituído.",
  "settings.sandboxPc.update.button": "Atualizar o serviço do PC sandbox",
  "settings.sandboxPc.update.failed": "O serviço do PC sandbox não foi atualizado: {reason}",
  "settings.sandboxPc.update.failedDid": "Nada mais foi alterado. Você pode tentar de novo.",
  "settings.sandboxPc.controls.title": "O PC sandbox",
  "settings.sandboxPc.controls.hint": "Crie uma vez e depois inicie e pare por aqui.",
  "settings.sandboxPc.controls.create": "Criar o PC sandbox",
  "settings.sandboxPc.controls.start": "Iniciar",
  "settings.sandboxPc.controls.stop": "Parar",
  "settings.sandboxPc.controls.resume": "Retomar",
  "settings.sandboxPc.controls.working": "Trabalhando…",
  "settings.sandboxPc.controls.helperOffline":
    "O helper do Windows não está rodando ou ainda não tem o PC sandbox, então ele não pode ser controlado. Reinicie o helper em Ajustes → Dispositivos.",
  "settings.sandboxPc.controls.failed": "Não funcionou: {reason}",
  "settings.sandboxPc.controls.waitForImage": "Termine de ativar acima primeiro.",
  "settings.sandboxPc.snapshots.title": "Snapshots",
  "settings.sandboxPc.snapshots.hint":
    "Salve o disco do PC sandbox para voltar a ele depois. Ele precisa estar parado para salvar ou restaurar.",
  "settings.sandboxPc.snapshots.none": "Nenhum snapshot ainda.",
  "settings.sandboxPc.snapshots.save": "Salvar um snapshot",
  "settings.sandboxPc.snapshots.saveFresh": "Salvar como PC novo",
  "settings.sandboxPc.snapshots.reset": "Voltar ao PC novo",
  "settings.sandboxPc.snapshots.restore": "Restaurar",
  "settings.sandboxPc.snapshots.delete": "Excluir",
  "settings.sandboxPc.snapshots.fresh": "PC novo",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "Pare o PC sandbox primeiro.",
  "onboarding.connectors.windowsHint":
    "No Windows, o {name} lê seus e-mails, calendário e contatos por uma conta Microsoft, Google ou IMAP.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "build {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "Este Mac",
  "platform.term.thisDeviceLower": "este Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Chaveiro",
  "platform.term.systemSettings": "Ajustes do Sistema",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "barra de menus",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "helper do Mac",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  "platform.macOnly": "Disponível no macOS",
  "platform.macOnlyHint": "{name} precisa de um Mac. O Psyche no macOS pode usá-lo.",
  "platform.windows.access.title": "Acesso do Windows",
  "platform.windows.access.hint": "O que o Windows permite ao Psyche e o que ele pede a você.",
  "platform.windows.access.noPermission": "Não precisa de permissão",
  "platform.windows.access.uiAutomation.name": "Usar apps",
  "platform.windows.access.uiAutomation.why":
    "{persona} lê e usa janelas de apps pela automação de interface do Windows. O Windows não deixa controlar apps executados como administrador.",
  "platform.windows.access.screen.name": "Captura de tela",
  "platform.windows.access.screen.why":
    "O Windows não precisa de permissão para capturar a tela. As janelas do Psyche e os campos de senha ficam ocultos nas capturas.",
  "platform.windows.access.microphone.name": "Microfone",
  "platform.windows.access.microphone.why":
    "Para ditado e notas de reuniões. O Windows pede em Configurações → Privacidade e segurança → Microfone, com “Permitir que aplicativos da área de trabalho acessem o microfone” ativado.",
  "platform.windows.access.openSettings": "Abrir Ajustes",
  "platform.windows.access.openSettingsFor": "Abrir as Configurações do Windows para {name}",
  "platform.windows.access.state.granted": "Ativado",
  "platform.windows.access.state.denied": "Desativado nas Configurações do Windows",
  "platform.windows.access.state.not_determined": "Ainda não verificado",
  "platform.helper.restart": "Reiniciar o helper",
  "platform.helper.restarting": "Reiniciando…",
  "platform.helper.restartFailed": "O helper não iniciou ({reason}).",
};
