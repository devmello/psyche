import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (pt); merged into `../pt.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Computadores que o Psyche pode usar",
  "machines.description":
    "Computadores Linux que você associou para o Psyche usar apps, comandos e arquivos lá enquanto você continua usando este.",
  "machines.empty":
    "Dê ao Psyche um computador Linux para trabalhar, para que ele use apps, comandos e arquivos lá enquanto você continua usando este.",
  "machines.add": "Adicionar um computador Linux",
  "machines.add.description":
    "O Psyche trabalha nesse computador enquanto você continua usando este. As ações lá seguem suas configurações de aprovação.",
  "machines.add.account": "Qual conta o Psyche deve usar lá?",
  "machines.add.account.own": "Sua conta (recomendado)",
  "machines.add.account.ownHint":
    "O Psyche pode usar lá seus arquivos, apps e logins, como você. Nunca recebe root.",
  "machines.add.account.dedicated": "Uma conta psyche separada",
  "machines.add.account.dedicatedHint":
    "O Psyche vê apenas os arquivos e apps dessa conta. Não tem sudo nem senha.",
  "machines.add.needsNetwork":
    "Outros computadores ainda não conseguem chegar a este. Ative primeiro o acesso remoto ou o acesso pela rede local em Ajustes → Servidor e acesso remoto.",
  "machines.add.make": "Mostrar os comandos",
  "machines.add.again": "Criar novos comandos",
  "machines.add.commands": "Comandos para o computador Linux",
  "machines.add.installStep": "1. No computador Linux, instale o assistente",
  "machines.add.pairStep": "2. Inicie a associação lá",
  "machines.add.expires": "O link funciona uma vez e expira {when}.",
  "machines.add.waiting": "Aguardando o computador se associar…",
  "machines.add.paired": "{name} está associado. O Psyche já pode usá-lo.",
  "machines.add.pairedToast": "{name} foi adicionado",
  "machines.add.done": "Concluir",
  "machines.copy": "Copiar",
  "machines.status.online": "Online",
  "machines.status.offline": "Offline",
  "machines.status.degraded": "Precisa de atenção",
  "machines.display.headless": "Tela privada",
  "machines.display.desktopSession": "Área de trabalho própria",
  "machines.display.container": "Contêiner",
  "machines.thisComputer": "Este computador",
  "machines.watch": "Assistir",
  "machines.watchNamed": "Assistir {name}",
  "machines.apps": "Acesso a apps",
  "machines.appsNamed": "Acesso a apps em {name}",
  "machines.folders": "Pastas",
  "machines.foldersNamed": "Pastas em {name}",
  "machines.rename.action": "Renomear",
  "machines.rename.named": "Renomear {name}",
  "machines.rename.label": "Novo nome para {name}",
  "machines.rename.save": "Salvar",
  "machines.rename.cancel": "Cancelar",
  "machines.remove": "Remover",
  "machines.removeTitle": "Remover {name}?",
  "machines.removeDescription":
    "O Psyche para de usar {name} na hora e a associação é revogada. Para usá-lo de novo, associe-o de novo.",
  "machines.err.nameTaken": "Outro computador já tem esse nome, ou ele é reservado. Escolha outro.",
  "machines.err.nameInvalid":
    "Esse nome não pode ser usado. Use letras, números e pontuação comuns, até 64 caracteres, e não misture letras parecidas.",
  "machines.err.forbidden":
    "Renomear exige um dispositivo administrador. Tente de novo a partir de um deles.",
  "machines.err.failed": "Não funcionou ({reason}). Nada mudou.",
  "machines.account.own":
    "Roda com a sua própria conta em {name}. O Psyche pode usar lá seus arquivos, apps e logins, como você. Se o seu Psyche algum dia fosse comprometido, um invasor também poderia, exceto para root, que o Psyche nunca recebe.",
  "machines.account.dedicated":
    "Roda com uma conta separada em {name}. O Psyche vê apenas os arquivos e apps dessa conta.",
  "machines.account.useSeparate": "Usar uma conta separada…",
  "machines.account.useSeparateHint":
    "Em {name}, rode o instalador de novo com a opção de conta separada e depois associe-o de novo:",
  "machines.shell.contained": "Os comandos rodam em um shell isolado",
  "machines.shell.full": "Os comandos rodam no shell completo da conta",
  "machines.shell.off": "Os comandos estão desativados",
  "machines.limits.folders":
    "{count, plural, =0 {Nenhuma pasta concedida} one {# pasta concedida} other {# pastas concedidas}}",
  "machines.helperVersion": "Assistente {version}",
  "machines.helperVersionUnknown": "Versão do assistente desconhecida",
  "machines.update": "Há um assistente mais novo. Atualize o assistente em {name}:",
  "machines.warnings": "Avisos para {name}",
  "machines.warn.fullShell":
    "Shell completo da conta. Os comandos não são isolados e alcançam tudo o que esta conta alcança.",
  "machines.warn.userLimits":
    "Os limites pertencem ao usuário. Qualquer programa executado com esta conta pode mudar o que o Psyche pode fazer em {name}.",
  "machines.warn.sudo":
    "Esta conta tem sudo sem senha. O Psyche não pode usar sudo aqui, mas outros programas que você executa com esta conta podem.",
  "machines.paired": "Associado {when}",
  "machines.line": "Em “{name}” · Linux · {place}",
  "machines.place.screen": "tela privada",
  "machines.place.desktop": "a área de trabalho dele",
  "machines.place.command": "comando",
  "machines.place.files": "arquivos",
  "machines.step.on": "{label} em {name}",
  "machines.picker.title": "Computadores",
  "machines.picker.description":
    "Escolha para qual computador são estes ajustes e onde o Psyche trabalha quando você não está olhando um em particular.",
  "machines.picker.show": "Mostrar o acesso a apps de",
  "machines.picker.default": "Computador padrão para trabalho em segundo plano",
  "machines.picker.defaultHint":
    "Tarefas e automações rodam lá, a menos que citem um computador. Escolha um computador Linux para o Psyche trabalhar lá enquanto você trabalha aqui.",
  "machines.picker.appsOn": "Apps em {name}",
  "machines.picker.appsHint":
    "O Psyche as sincroniza com {name} e nunca passa dos limites próprios desse computador.",
  "machines.picker.noApps":
    "O Psyche ainda não viu apps em {name}. Eles aparecem aqui quando ele vir.",
  "machines.picker.offline": "{name} está offline. As mudanças chegam quando ele se reconectar.",
  "computerWatch.titleMachine": "{name} · tela privada",
  "computerWatch.machineOffline": "Não foi possível alcançar {name}. Tentando de novo…",
  "computerWatch.empty.bodyMachine":
    "Quando o agente precisar de uma tela em {name}, você poderá assisti-la aqui.",
  "notice.machine.working.title": "O Psyche está trabalhando em {name}",
  "notice.machine.working.body":
    "Ele está usando a tela, os apps ou os arquivos desse computador. Acompanhe em Ajustes → Dispositivos.",
  "notice.machine.offline.title": "{name} ficou offline",
  "notice.machine.offline.body":
    "O Psyche não pode usá-lo até que ele se reconecte. As tarefas que precisam dele esperam por você.",
  "machines.add.linkStep": "3. Quando pedir o link, cole este",
  "machines.add.installSource":
    "Obtenha o pacote do assistente em {url}, descompacte-o e execute isto no computador Linux.",
  "machines.reports": "{name} informa:",
  "computerWatch.machineLoading": "Carregando computador…",
  "computerWatch.machineMissing": "Esse computador não está disponível.",
  "settings.key.computerUse.defaultMachine": "Computador padrão para trabalho em segundo plano",
  "settings.key.computerUse.machineApps": "Acesso a apps em um computador Linux",
  "machines.card.folder": "Pasta",
  "machines.card.runsContained": "isolado, só na pasta concedida: sem chaves, perfis do navegador ou outras pastas",
  "machines.card.runsFullAccount": "com a conta completa: pode fazer tudo o que essa conta pode",
  "machines.card.networkOff": "desativada",
  "machines.card.networkOn": "ativada",
  "machines.card.folderReadOnly": "{path}, somente leitura",
  "machines.card.folderReadWrite": "{path}, leitura e escrita",
  "machines.card.folderNotEnforced": "{path}, somente leitura não é aplicado com a conta completa",
};
