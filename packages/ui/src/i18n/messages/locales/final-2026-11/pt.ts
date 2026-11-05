import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (pt-BR); merged into `../pt.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "Conector compartilhado {name}",
  "settings.connectorBundle.intro":
    "Alguém compartilhou este conector como um arquivo. Nada foi instalado ainda. Confira quem o criou e o que ele pede, e depois decida.",
  "settings.connectorBundle.update": "Esta é uma atualização do conector que você tem.",
  "settings.connectorBundle.signer.title": "Quem criou",
  "settings.connectorBundle.signer.unsigned":
    "Este arquivo não tem assinatura, então não há como saber quem o criou.",
  "settings.connectorBundle.signer.dropped": "A versão instalada tinha assinatura. Esta não tem.",
  "settings.connectorBundle.signer.new": "Assinado por {name}. Você nunca viu esta chave antes.",
  "settings.connectorBundle.signer.seen":
    "Assinado por {name}, com uma chave que você já viu, mas em que não confia.",
  "settings.connectorBundle.signer.trusted": "Assinado por {name}, um autor em quem você confia.",
  "settings.connectorBundle.signer.own": "Assinado por você.",
  "settings.connectorBundle.signer.changed":
    "Assinado por {name}, mas não com a chave vista antes. Confira se é a mesma pessoa.",
  "settings.connectorBundle.signer.impersonates":
    "Assinado com um nome parecido com o seu, usando uma chave que não é sua.",
  "settings.connectorBundle.signer.nameChanged":
    "Uma chave em que você confia está assinando com um nome que não usava antes: {name}.",
  "settings.connectorBundle.signer.revoked": "Assinado por uma chave que você revogou.",
  "settings.connectorBundle.signer.rotated":
    "Assinado por {name}: mesmo autor, chave nova (assinada pela chave antiga). A chave nova não é confiável até que você confie nela.",
  "settings.connectorBundle.signer.claim":
    "O nome é uma alegação do próprio autor. Só a chave o identifica.",
  "settings.connectorBundle.signer.key": "Chave do autor",
  "settings.connectorBundle.signer.trust": "Confiar em {name} como autor",
  "settings.connectorBundle.signer.trustHint":
    "Isso muda apenas o rótulo e os avisos de arquivos futuros. Nunca pula este cartão.",
  "settings.connectorBundle.command": "Comando que ele executa",
  "settings.connectorBundle.commandHint":
    "Primeiro o programa, depois cada argumento em sua própria linha. Não é executado por um shell.",
  "settings.connectorBundle.network": "Rede que ele pede",
  "settings.connectorBundle.noNetwork": "Sem rede",
  "settings.connectorBundle.networkHint":
    "Só a sandbox consegue impor isso. A lista é o que o autor diz.",
  "settings.connectorBundle.env": "Variáveis que ele lê",
  "settings.connectorBundle.noEnv": "Nenhuma",
  "settings.connectorBundle.envHint": "Só os nomes. Você dá os valores depois de instalar.",
  "settings.connectorBundle.secrets": "Segredos de que ele precisa",
  "settings.connectorBundle.noSecrets": "Nenhum",
  "settings.connectorBundle.secretsHint":
    "Só os nomes. O arquivo não leva nenhum segredo. Depois de instalar, você dá um valor a cada um, e ele fica guardado no seu cofre.",
  "settings.connectorBundle.tools": "Ferramentas que o autor diz que ele lista",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# ferramenta} other {# ferramentas}}",
  "settings.connectorBundle.toolsHint":
    "O Psyche o inicia na sandbox e lista o que ele realmente oferece. Essas ferramentas são as que contam.",
  "settings.connectorBundle.toolsUndeclared":
    "O servidor listou ferramentas que o arquivo não declarou: {names}",
  "settings.connectorBundle.toolsMissing":
    "O arquivo declarou ferramentas que o servidor não listou: {names}",
  "settings.connectorBundle.files": "Scripts que vêm com ele ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "Não é texto, então não pode ser mostrado aqui.",
  "settings.connectorBundle.findings": "O que as verificações encontraram",
  "settings.connectorBundle.finding.high": "Impede a instalação: {message}",
  "settings.connectorBundle.finding.warn": "Confira: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "A primeira execução é na sandbox. O Psyche o inicia lá para listar suas ferramentas, e ele continua rodando lá.",
  "settings.connectorBundle.sandbox.container":
    "A primeira execução é em um contêiner de sandbox. O Psyche o inicia lá para listar suas ferramentas, e ele continua rodando lá.",
  "settings.connectorBundle.sandbox.none":
    "Este Mac não tem sandbox para conectores de comando, e o Psyche nunca executa um fora dela. Este conector não pode ser instalado aqui. Nada foi iniciado nem salvo.",
  "settings.connectorBundle.blocker.scan":
    "As verificações encontraram algo que impede a instalação. Nada foi iniciado nem salvo.",
  "settings.connectorBundle.blocker.probe_failed":
    "A primeira execução, sem rede e sem segredos, não conseguiu iniciá-lo. Nada foi salvo.",
  "settings.connectorBundle.signer.ownRetired":
    "Assinado com uma chave sua que você substituiu. Ela não é mais tratada como sua.",
  "settings.connectorBundle.signer.retired":
    "Assinado por {name}, com uma chave que foi substituída por uma rotação que você viu. Um arquivo novo com essa assinatura é suspeito.",
  "settings.connectorBundle.carry.kept": "Valores que você deu e que permanecem: {names}",
  "settings.connectorBundle.carry.cleared":
    "Valores que você deu e que não são mantidos, porque quem assina ou o comando mudou. Digite-os de novo: {names}",
  "settings.connectorBundle.carry.vault":
    "Os segredos que você guardou antes continuam no seu cofre, mas não são entregues a esta versão.",
  "settings.connectorBundle.reset.title":
    "Se o registro de conectores compartilhados estiver danificado",
  "settings.connectorBundle.reset.hint":
    "Conectores que vieram de um arquivo ficam desativados enquanto o registro deles não puder ser lido. Isto separa o registro danificado (restaurando a última cópia boa, se houver); esses conectores continuam desativados até você removê-los ou importá-los de novo.",
  "settings.connectorBundle.reset.go": "Redefinir o registro…",
  "settings.connectorBundle.reset.confirm": "Sim, redefinir",
  "settings.connectorBundle.reset.done":
    "O registro foi redefinido. {restored, select, true {A última cópia boa foi restaurada.} other {Ele começa vazio.}}",
  "settings.connectorBundle.reset.failed": "Não foi possível redefinir o registro: {reason}",
  "settings.connectorBundle.hash": "ID do pacote",
  "settings.connectorBundle.close": "Fechar",
  "settings.connectorBundle.widened.title": "Pede mais do que a versão que você tem",
  "settings.connectorBundle.widened.hint":
    "Aprovar este cartão dá tudo isso a ele. Um cartão para a versão mais restrita não teria coberto.",
  "settings.connectorBundle.widened.command": "Um comando diferente",
  "settings.connectorBundle.widened.commandValue": "Agora {now}. Antes: {before}",
  "settings.connectorBundle.widened.env": "Mais variáveis",
  "settings.connectorBundle.widened.secrets": "Mais segredos",
  "settings.connectorBundle.widened.network": "Mais rede",
  "settings.connectorBundle.widened.tools": "Mais ferramentas, ou ferramentas que podem fazer mais",
  "settings.connectorBundle.widened.payload": "Scripts diferentes",
  "settings.connectorBundle.widened.payloadValue": "Os arquivos incluídos mudaram",
  "settings.connectorBundle.diff": "O que mudou",
  "settings.connectorBundle.noChanges": "Nada mais mudou.",
  "settings.connectorBundle.import.title": "Conectores compartilhados",
  "settings.connectorBundle.import.hint":
    "Importe um conector que alguém enviou a você como arquivo ou link. Você vê tudo o que ele pede antes de qualquer coisa ser instalada.",
  "settings.connectorBundle.import.file": "Importar um arquivo de conector",
  "settings.connectorBundle.import.linkLabel": "Ou cole um link para um",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "Revisar",
  "settings.connectorBundle.import.checking": "Verificando…",
  "settings.connectorBundle.import.failed": "Não foi possível importar o conector: {reason}",
  "settings.connectorBundle.import.tooBig": "Esse arquivo é grande demais para ser um conector.",
  "settings.connectorBundle.import.denied": "{name} não foi instalado.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {O cartão de {name} expirou.} other {O cartão de {name} não vale mais.}} Importe-o de novo para revisá-lo.",
  "settings.connectorBundle.import.added":
    "{name} foi adicionado. Dê a ele abaixo os segredos de que precisa, e então ele poderá usá-los.",
  "settings.connectorBundle.import.addedNoSecrets": "{name} foi adicionado.",
  "settings.connectorBundle.import.addFailed": "Não foi possível adicionar {name}: {reason}",
  "settings.connectorBundle.import.secretsTitle": "Segredos de {name}",
  "settings.connectorBundle.share.title": "Compartilhar este conector",
  "settings.connectorBundle.share.hint":
    "Cria um arquivo assinado com o comando, os nomes de suas variáveis e segredos, a rede que ele acessa e suas ferramentas. Nenhum valor é incluído. Você confirma antes o que vai nele.",
  "settings.connectorBundle.share.go": "Compartilhar…",
  "settings.connectorBundle.share.nameLabel": "Seu nome nos conectores compartilhados",
  "settings.connectorBundle.share.nameHint":
    "Todos que importarem um arquivo seu veem este nome. Ele é pedido uma vez; sua chave de assinatura é criada agora.",
  "settings.connectorBundle.share.make": "Criar o arquivo",
  "settings.connectorBundle.share.label": "Compartilhar {name}",
  "settings.connectorBundle.share.done":
    "{file} salvo, assinado como {author}. Ele contém só nomes: nenhum valor de variável ou segredo.",
  "settings.connectorBundle.share.failed": "Não foi possível compartilhar o conector: {reason}",
  "settings.connectorBundle.share.unavailable":
    "Só o Psyche no Mac que o executa pode assinar um conector.",
  "settings.skills.signer.ownRetired":
    "Assinado com uma chave sua que você substituiu. Ela não é mais tratada como sua.",
  "settings.skills.signer.retired":
    "Assinado por {name}, com uma chave que foi substituída por uma rotação que você viu. Um arquivo novo com essa assinatura é suspeito.",
  "settings.skills.signer.rotated":
    "Assinado por {name}: mesmo autor, chave nova (assinada pela chave antiga). A chave nova não é confiável até que você confie nela.",
  "settings.skills.author.state.seen": "Vista, sem confiança",
  "settings.skills.author.state.trusted": "Confiável",
  "settings.skills.author.state.revoked": "Revogada",
  "settings.skills.keys.title": "Sua chave de autor e avisos",
  "settings.skills.keys.hint":
    "A chave que assina as habilidades e os conectores que você compartilha. Você pode substituí-la e publicar um aviso quando uma chave ou um arquivo não deva mais ser confiável.",
  "settings.skills.keys.none":
    "Você ainda não assinou nada. Sua chave é criada na primeira vez que você compartilha uma habilidade ou um conector.",
  "settings.skills.keys.own": "Assinando como {name}",
  "settings.skills.keys.fingerprint": "Chave",
  "settings.skills.keys.rotate": "Substituir minha chave…",
  "settings.skills.keys.rotateHint":
    "Cria uma chave nova com o mesmo nome. A chave antiga assina uma declaração que nomeia a nova, para que quem confiava em você veja o mesmo autor com uma chave nova. Ainda assim, essas pessoas precisam confiar nela por conta própria. Você confirma antes.",
  "settings.skills.keys.rotateLabel": "Substituir sua chave de autor",
  "settings.skills.keys.rotated": "Sua chave foi substituída. A nova chave é {key}.",
  "settings.skills.keys.rotateFailed": "Não foi possível substituir a chave: {reason}",
  "settings.skills.keys.notice.title": "Publicar um aviso",
  "settings.skills.keys.notice.hint":
    "Um aviso é um pequeno arquivo assinado. Envie-o ou hospede-o, e qualquer pessoa que já conheça sua chave pode importá-lo para bloquear uma chave ou um arquivo.",
  "settings.skills.keys.notice.kindKey": "Minha chave (a atual)",
  "settings.skills.keys.notice.kindBundle": "Um arquivo que compartilhei, pelo ID do pacote",
  "settings.skills.keys.notice.kind": "O que é ruim",
  "settings.skills.keys.notice.hash": "ID do pacote (sha256:…)",
  "settings.skills.keys.notice.reason": "Por quê (todos que o importarem veem isto)",
  "settings.skills.keys.notice.make": "Criar o aviso",
  "settings.skills.keys.notice.label": "Assinar um aviso de revogação",
  "settings.skills.keys.notice.done": "{file} salvo. Publique-o como preferir.",
  "settings.skills.keys.notice.failed": "Não foi possível criar o aviso: {reason}",
  "settings.skills.keys.import.title": "Importar um aviso de revogação",
  "settings.skills.keys.import.hint":
    "Só é aplicado se for assinado por um autor que você já conheceu. Ele só pode bloquear: nunca passa a confiar em nada.",
  "settings.skills.keys.import.file": "Importar um arquivo de aviso",
  "settings.skills.keys.import.linkLabel": "Ou cole um link",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "Importar",
  "settings.skills.keys.import.key": "Chave {key} bloqueada. Motivo informado: {reason}",
  "settings.skills.keys.import.bundle": "Arquivo {hash} bloqueado. Motivo informado: {reason}",
  "settings.skills.keys.import.previewKey":
    "Isto vai revogar a chave {key}{names, select, none {} other { (conhecida como {names})}}. Motivo informado por quem assinou: {reason}",
  "settings.skills.keys.import.previewBundle":
    "Isto vai bloquear o arquivo {hash}. Motivo informado por quem assinou: {reason}",
  "settings.skills.keys.import.already": "Ele já está em vigor.",
  "settings.skills.keys.import.apply": "Aplicar",
  "settings.skills.keys.import.signedBy": "Assinado por {name}.",
  "settings.skills.keys.import.failed": "Não foi possível usar o aviso: {reason}",
  "web.teach.app.record": "Gravar em um app",
  "web.teach.app.recordHint":
    "Mostrar ao Psyche como fazer algo em um app do Mac que você já permitiu",
  "web.teach.app.pickTitle": "Gravar em qual app?",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "Só aparecem os apps que você permitiu para o uso do computador. Abra o app primeiro. Senhas, números de cartão e códigos nunca são gravados, nem as janelas do próprio Psyche ou os avisos de login e segurança.",
  "web.teach.app.none":
    "Nenhum app está pronto para gravar. Ative o uso do computador nos Ajustes e dê a um app o nível Clicar ou Interagir primeiro.",
  "web.teach.app.start": "Iniciar a gravação",
  "web.teach.app.cancelPick": "Agora não",
  "web.teach.app.startFailed":
    "O Psyche não conseguiu iniciar a gravação desse app. Abra-o primeiro e confira se o Psyche tem acesso de Acessibilidade.",
  "web.teach.app.bar.title": "Gravando {app}",
  "web.teach.app.bar.body":
    "O Psyche anota seus cliques, escolhas de menu e digitação apenas em {app}. Campos seguros nunca são gravados, nenhuma captura de tela é feita, e nada sai deste Mac até você salvar. A barra de menus também tem um botão Parar.",
  "web.teach.app.bar.endedLimit":
    "A gravação parou no limite de 200 passos. Revise o que ela captou.",
  "web.teach.app.bar.endedTimeout":
    "A gravação parou ao atingir o limite de tempo. Revise o que ela captou.",
  "web.teach.app.bar.endedInterrupted":
    "A gravação terminou antes da hora porque o app foi fechado. Revise o que ela captou.",
  "web.teach.app.stopFailed": "O Psyche não conseguiu concluir a gravação.",
  "web.teach.app.skipped":
    "{count, plural, one {# item foi deixado de fora: um campo seguro ou um controle sem nome para localizá-lo.} other {# itens foram deixados de fora: campos seguros ou controles sem nome para localizá-los.}}",
  "web.teach.app.privacy":
    "O texto destes passos veio das janelas e dos menus do app. Ele é tratado como dado, nunca como instrução. Ao salvar, você precisa aprovar a habilidade antes que ela possa ser executada.",
  "web.teach.app.sensitive": "Não gravado. O Psyche vai pedir que você faça esta parte.",
  "web.teach.app.runHint":
    "Preenche a caixa de mensagem com a habilidade. Pressione Enviar e acompanhe o app: cada clique e cada digitação pede aprovação como de costume, e ele para e pergunta se algo não estiver onde estava.",
  "web.teach.step.app.click": "Em {app}, clique em “{name}”",
  "web.teach.step.app.clickRole": "Em {app}, clique em {role}",
  "web.teach.step.app.menu": "Em {app}, escolha {path}",
  "web.teach.step.app.type": "Em {app}, digite em “{name}”",
  "web.teach.step.app.typeKept": "Em {app}, digite {value} em “{name}”",
  "web.teach.step.app.typeInput": "Em {app}, digite {input} em “{name}”",
  "web.teach.step.app.typeAsk": "Em {app}, digite em “{name}” o que você informar",
  "web.teach.step.app.typeSensitive": "Em {app}, você mesmo digita em “{name}”",
};
