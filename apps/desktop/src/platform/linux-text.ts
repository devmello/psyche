/**
 * The words the Linux uninstall sheet and its native confirmation use (Linux desktop design §2.5).
 * Main has no message catalogue (packages/ui owns it), so, like `replace-key-dialog.ts`, the ten
 * languages the app ships live next to the code, picked by the OS locale. `{name}` placeholders
 * are filled by {@link fillText}. `test/platform/linux-text.test.ts` checks every language has
 * every key and the same placeholders as English.
 */
export interface LinuxUninstallText {
  stopGateway: string;
  stopHelper: string;
  stopDesktops: string;
  itemService: string;
  itemAutostart: string;
  itemLauncher: string;
  itemSettings: string;
  itemCaches: string;
  itemHelperState: string;
  itemPrevious: string;
  itemData: string;
  itemApp: string;
  warnOtherUnit: string;
  /** `{command}` */
  warnPackage: string;
  confirmTitle: string;
  confirmCancel: string;
  confirmUninstall: string;
  confirmDeleteData: string;
  /** `{count}` */
  confirmItems: string;
  /** `{folder}` */
  confirmDataTrashed: string;
  confirmDataKept: string;
  confirmPackage: string;
  /** `{detail}` and `{command}` */
  packageFailed: string;
}

const EN: LinuxUninstallText = {
  stopGateway: "Stop and disable the Psyche Gateway service",
  stopHelper: "Stop the Psyche helper and turn off open at login",
  stopDesktops: "Stop Psyche's virtual screen and separate desktop containers",
  itemService: "Gateway service file",
  itemAutostart: "Open-at-login entry",
  itemLauncher: "Application menu entry",
  itemSettings: "Application settings",
  itemCaches: "Caches",
  itemHelperState: "Helper state",
  itemPrevious: "Previous version kept for going back",
  itemData: "Psyche data",
  itemApp: "Psyche AppImage",
  warnOtherUnit:
    "The psyche-gateway service belongs to another copy of Psyche or to the command-line tool; it is left alone",
  warnPackage:
    "Psyche came from a package. Removing it asks for your administrator password and runs: {command}",
  confirmTitle: "Uninstall Psyche?",
  confirmCancel: "Cancel",
  confirmUninstall: "Uninstall",
  confirmDeleteData: "Delete data and uninstall",
  confirmItems: "{count} item(s) will be moved to the Trash.",
  confirmDataTrashed: "Your data folder {folder} will be moved to the Trash too.",
  confirmDataKept: "Your data folder is kept.",
  confirmPackage:
    "The package manager will remove the app after you enter your administrator password.",
  packageFailed:
    "The package manager could not remove Psyche ({detail}). To finish, run: {command}",
};

export const LINUX_UNINSTALL_TEXT: Record<string, LinuxUninstallText> = {
  en: EN,
  zh: {
    stopGateway: "停止并禁用 Psyche 网关服务",
    stopHelper: "停止 Psyche 辅助程序并关闭登录时打开",
    stopDesktops: "停止 Psyche 的虚拟屏幕和独立桌面容器",
    itemService: "网关服务文件",
    itemAutostart: "登录时打开的条目",
    itemLauncher: "应用程序菜单条目",
    itemSettings: "应用设置",
    itemCaches: "缓存",
    itemHelperState: "辅助程序状态",
    itemPrevious: "为回退而保留的上一版本",
    itemData: "Psyche 数据",
    itemApp: "Psyche AppImage",
    warnOtherUnit: "psyche-gateway 服务属于另一份 Psyche 或命令行工具，不会被改动",
    warnPackage: "Psyche 是通过软件包安装的。移除它需要输入管理员密码，并会运行：{command}",
    confirmTitle: "要卸载 Psyche 吗？",
    confirmCancel: "取消",
    confirmUninstall: "卸载",
    confirmDeleteData: "删除数据并卸载",
    confirmItems: "将有 {count} 项被移到废纸篓。",
    confirmDataTrashed: "你的数据文件夹 {folder} 也会被移到废纸篓。",
    confirmDataKept: "你的数据文件夹会保留。",
    confirmPackage: "输入管理员密码后，软件包管理器会移除此应用。",
    packageFailed: "软件包管理器无法移除 Psyche（{detail}）。请手动完成，运行：{command}",
  },
  ar: {
    stopGateway: "إيقاف خدمة بوابة Psyche وتعطيلها",
    stopHelper: "إيقاف مساعد Psyche وإيقاف الفتح عند تسجيل الدخول",
    stopDesktops: "إيقاف الشاشة الافتراضية وحاويات سطح المكتب المنفصل في Psyche",
    itemService: "ملف خدمة البوابة",
    itemAutostart: "إدخال الفتح عند تسجيل الدخول",
    itemLauncher: "إدخال قائمة التطبيقات",
    itemSettings: "إعدادات التطبيق",
    itemCaches: "ذاكرات التخزين المؤقت",
    itemHelperState: "حالة المساعد",
    itemPrevious: "الإصدار السابق المحفوظ للرجوع إليه",
    itemData: "بيانات Psyche",
    itemApp: "ملف Psyche AppImage",
    warnOtherUnit:
      "خدمة psyche-gateway تخص نسخة أخرى من Psyche أو أداة سطر الأوامر، لذا تُترك كما هي",
    warnPackage: "جاء Psyche من حزمة. تتطلب إزالته كلمة مرور المسؤول وتشغّل: {command}",
    confirmTitle: "إلغاء تثبيت Psyche؟",
    confirmCancel: "إلغاء",
    confirmUninstall: "إلغاء التثبيت",
    confirmDeleteData: "حذف البيانات وإلغاء التثبيت",
    confirmItems: "سيتم نقل {count} عنصر إلى سلة المهملات.",
    confirmDataTrashed: "سيتم نقل مجلد بياناتك {folder} إلى سلة المهملات أيضًا.",
    confirmDataKept: "سيبقى مجلد بياناتك كما هو.",
    confirmPackage: "سيزيل مدير الحزم التطبيق بعد إدخال كلمة مرور المسؤول.",
    packageFailed: "تعذّرت على مدير الحزم إزالة Psyche ({detail}). لإكمال ذلك شغّل: {command}",
  },
  fr: {
    stopGateway: "Arrêter et désactiver le service Gateway de Psyche",
    stopHelper: "Arrêter l'assistant Psyche et désactiver l'ouverture à la connexion",
    stopDesktops: "Arrêter l'écran virtuel et les conteneurs de bureau séparé de Psyche",
    itemService: "Fichier du service Gateway",
    itemAutostart: "Entrée d'ouverture à la connexion",
    itemLauncher: "Entrée du menu des applications",
    itemSettings: "Réglages de l'application",
    itemCaches: "Caches",
    itemHelperState: "État de l'assistant",
    itemPrevious: "Version précédente conservée pour revenir en arrière",
    itemData: "Données de Psyche",
    itemApp: "AppImage de Psyche",
    warnOtherUnit:
      "Le service psyche-gateway appartient à une autre copie de Psyche ou à l'outil en ligne de commande ; il est laissé tel quel",
    warnPackage:
      "Psyche provient d'un paquet. Le supprimer demande votre mot de passe administrateur et exécute : {command}",
    confirmTitle: "Désinstaller Psyche ?",
    confirmCancel: "Annuler",
    confirmUninstall: "Désinstaller",
    confirmDeleteData: "Supprimer les données et désinstaller",
    confirmItems: "{count} élément(s) seront placés dans la corbeille.",
    confirmDataTrashed: "Votre dossier de données {folder} sera aussi placé dans la corbeille.",
    confirmDataKept: "Votre dossier de données est conservé.",
    confirmPackage:
      "Le gestionnaire de paquets supprimera l'application après la saisie de votre mot de passe administrateur.",
    packageFailed:
      "Le gestionnaire de paquets n'a pas pu supprimer Psyche ({detail}). Pour terminer, exécutez : {command}",
  },
  it: {
    stopGateway: "Arresta e disattiva il servizio Gateway di Psyche",
    stopHelper: "Arresta l'assistente di Psyche e disattiva l'apertura all'accesso",
    stopDesktops: "Arresta lo schermo virtuale e i container del desktop separato di Psyche",
    itemService: "File del servizio Gateway",
    itemAutostart: "Voce di apertura all'accesso",
    itemLauncher: "Voce del menu delle applicazioni",
    itemSettings: "Impostazioni dell'app",
    itemCaches: "Cache",
    itemHelperState: "Stato dell'assistente",
    itemPrevious: "Versione precedente conservata per tornare indietro",
    itemData: "Dati di Psyche",
    itemApp: "AppImage di Psyche",
    warnOtherUnit:
      "Il servizio psyche-gateway appartiene a un'altra copia di Psyche o allo strumento da riga di comando; viene lasciato com'è",
    warnPackage:
      "Psyche proviene da un pacchetto. Rimuoverlo richiede la password di amministratore ed esegue: {command}",
    confirmTitle: "Disinstallare Psyche?",
    confirmCancel: "Annulla",
    confirmUninstall: "Disinstalla",
    confirmDeleteData: "Elimina i dati e disinstalla",
    confirmItems: "{count} elemento/i verranno spostati nel Cestino.",
    confirmDataTrashed: "Anche la cartella dei dati {folder} verrà spostata nel Cestino.",
    confirmDataKept: "La cartella dei dati viene conservata.",
    confirmPackage:
      "Il gestore dei pacchetti rimuoverà l'app dopo l'inserimento della password di amministratore.",
    packageFailed:
      "Il gestore dei pacchetti non è riuscito a rimuovere Psyche ({detail}). Per finire, esegui: {command}",
  },
  ja: {
    stopGateway: "Psyche ゲートウェイサービスを停止して無効にする",
    stopHelper: "Psyche ヘルパーを停止し、ログイン時に開く設定をオフにする",
    stopDesktops: "Psyche の仮想画面と別デスクトップのコンテナを停止する",
    itemService: "ゲートウェイのサービスファイル",
    itemAutostart: "ログイン時に開くエントリ",
    itemLauncher: "アプリケーションメニューのエントリ",
    itemSettings: "アプリの設定",
    itemCaches: "キャッシュ",
    itemHelperState: "ヘルパーの状態",
    itemPrevious: "元に戻すために残してある前のバージョン",
    itemData: "Psyche のデータ",
    itemApp: "Psyche AppImage",
    warnOtherUnit:
      "psyche-gateway サービスは別の Psyche かコマンドラインツールのものなので、そのままにします",
    warnPackage:
      "Psyche はパッケージからインストールされています。削除には管理者パスワードが必要で、次を実行します: {command}",
    confirmTitle: "Psyche をアンインストールしますか？",
    confirmCancel: "キャンセル",
    confirmUninstall: "アンインストール",
    confirmDeleteData: "データを削除してアンインストール",
    confirmItems: "{count} 件の項目をゴミ箱に移動します。",
    confirmDataTrashed: "データフォルダ {folder} もゴミ箱に移動します。",
    confirmDataKept: "データフォルダは残ります。",
    confirmPackage: "管理者パスワードを入力すると、パッケージマネージャがアプリを削除します。",
    packageFailed:
      "パッケージマネージャが Psyche を削除できませんでした（{detail}）。完了するには次を実行してください: {command}",
  },
  de: {
    stopGateway: "Den Psyche-Gateway-Dienst stoppen und deaktivieren",
    stopHelper: "Den Psyche-Helfer stoppen und „Beim Anmelden öffnen“ ausschalten",
    stopDesktops:
      "Den virtuellen Bildschirm und die Container des getrennten Desktops von Psyche stoppen",
    itemService: "Dienstdatei des Gateways",
    itemAutostart: "Eintrag „Beim Anmelden öffnen“",
    itemLauncher: "Eintrag im Anwendungsmenü",
    itemSettings: "App-Einstellungen",
    itemCaches: "Zwischenspeicher",
    itemHelperState: "Status des Helfers",
    itemPrevious: "Vorherige Version zum Zurückgehen",
    itemData: "Psyche-Daten",
    itemApp: "Psyche-AppImage",
    warnOtherUnit:
      "Der Dienst psyche-gateway gehört zu einer anderen Kopie von Psyche oder zum Kommandozeilenwerkzeug und bleibt unberührt",
    warnPackage:
      "Psyche stammt aus einem Paket. Das Entfernen verlangt dein Administratorpasswort und führt aus: {command}",
    confirmTitle: "Psyche deinstallieren?",
    confirmCancel: "Abbrechen",
    confirmUninstall: "Deinstallieren",
    confirmDeleteData: "Daten löschen und deinstallieren",
    confirmItems: "{count} Objekt(e) werden in den Papierkorb verschoben.",
    confirmDataTrashed: "Dein Datenordner {folder} wird ebenfalls in den Papierkorb verschoben.",
    confirmDataKept: "Dein Datenordner bleibt erhalten.",
    confirmPackage:
      "Die Paketverwaltung entfernt die App, nachdem du dein Administratorpasswort eingegeben hast.",
    packageFailed:
      "Die Paketverwaltung konnte Psyche nicht entfernen ({detail}). Führe zum Abschließen aus: {command}",
  },
  hi: {
    stopGateway: "Psyche Gateway सेवा रोकें और बंद करें",
    stopHelper: "Psyche हेल्पर रोकें और लॉगिन पर खोलना बंद करें",
    stopDesktops: "Psyche की वर्चुअल स्क्रीन और अलग डेस्कटॉप कंटेनर रोकें",
    itemService: "Gateway सेवा फ़ाइल",
    itemAutostart: "लॉगिन पर खोलने की प्रविष्टि",
    itemLauncher: "एप्लिकेशन मेनू की प्रविष्टि",
    itemSettings: "ऐप की सेटिंग",
    itemCaches: "कैश",
    itemHelperState: "हेल्पर की स्थिति",
    itemPrevious: "वापस जाने के लिए रखा गया पिछला संस्करण",
    itemData: "Psyche डेटा",
    itemApp: "Psyche AppImage",
    warnOtherUnit:
      "psyche-gateway सेवा Psyche की किसी दूसरी प्रति या कमांड-लाइन टूल की है; उसे वैसे ही छोड़ा जाएगा",
    warnPackage:
      "Psyche एक पैकेज से आया है। इसे हटाने के लिए आपका एडमिनिस्ट्रेटर पासवर्ड माँगा जाएगा और यह चलेगा: {command}",
    confirmTitle: "Psyche अनइंस्टॉल करें?",
    confirmCancel: "रद्द करें",
    confirmUninstall: "अनइंस्टॉल करें",
    confirmDeleteData: "डेटा हटाएँ और अनइंस्टॉल करें",
    confirmItems: "{count} आइटम ट्रैश में भेजे जाएँगे।",
    confirmDataTrashed: "आपका डेटा फ़ोल्डर {folder} भी ट्रैश में भेजा जाएगा।",
    confirmDataKept: "आपका डेटा फ़ोल्डर रखा जाएगा।",
    confirmPackage: "एडमिनिस्ट्रेटर पासवर्ड डालने के बाद पैकेज मैनेजर ऐप हटा देगा।",
    packageFailed: "पैकेज मैनेजर Psyche को हटा नहीं सका ({detail})। पूरा करने के लिए यह चलाएँ: {command}",
  },
  ko: {
    stopGateway: "Psyche 게이트웨이 서비스를 중지하고 비활성화",
    stopHelper: "Psyche 도우미를 중지하고 로그인 시 열기를 끄기",
    stopDesktops: "Psyche의 가상 화면과 별도 데스크톱 컨테이너를 중지",
    itemService: "게이트웨이 서비스 파일",
    itemAutostart: "로그인 시 열기 항목",
    itemLauncher: "애플리케이션 메뉴 항목",
    itemSettings: "앱 설정",
    itemCaches: "캐시",
    itemHelperState: "도우미 상태",
    itemPrevious: "되돌리기 위해 남겨 둔 이전 버전",
    itemData: "Psyche 데이터",
    itemApp: "Psyche AppImage",
    warnOtherUnit:
      "psyche-gateway 서비스는 다른 Psyche 사본이나 명령줄 도구의 것이므로 그대로 둡니다",
    warnPackage:
      "Psyche는 패키지로 설치되었습니다. 제거하려면 관리자 암호가 필요하며 다음을 실행합니다: {command}",
    confirmTitle: "Psyche를 제거할까요?",
    confirmCancel: "취소",
    confirmUninstall: "제거",
    confirmDeleteData: "데이터를 삭제하고 제거",
    confirmItems: "{count}개 항목이 휴지통으로 이동됩니다.",
    confirmDataTrashed: "데이터 폴더 {folder}도 휴지통으로 이동됩니다.",
    confirmDataKept: "데이터 폴더는 유지됩니다.",
    confirmPackage: "관리자 암호를 입력하면 패키지 관리자가 앱을 제거합니다.",
    packageFailed:
      "패키지 관리자가 Psyche를 제거하지 못했습니다({detail}). 마무리하려면 다음을 실행하세요: {command}",
  },
  pt: {
    stopGateway: "Parar e desativar o serviço Gateway do Psyche",
    stopHelper: "Parar o auxiliar do Psyche e desativar a abertura ao iniciar a sessão",
    stopDesktops: "Parar a tela virtual e os contêineres de área de trabalho separada do Psyche",
    itemService: "Arquivo do serviço Gateway",
    itemAutostart: "Entrada de abertura ao iniciar a sessão",
    itemLauncher: "Entrada do menu de aplicativos",
    itemSettings: "Configurações do aplicativo",
    itemCaches: "Caches",
    itemHelperState: "Estado do auxiliar",
    itemPrevious: "Versão anterior guardada para voltar atrás",
    itemData: "Dados do Psyche",
    itemApp: "AppImage do Psyche",
    warnOtherUnit:
      "O serviço psyche-gateway pertence a outra cópia do Psyche ou à ferramenta de linha de comando; ele será deixado como está",
    warnPackage:
      "O Psyche veio de um pacote. Removê-lo pede a senha de administrador e executa: {command}",
    confirmTitle: "Desinstalar o Psyche?",
    confirmCancel: "Cancelar",
    confirmUninstall: "Desinstalar",
    confirmDeleteData: "Excluir os dados e desinstalar",
    confirmItems: "{count} item(ns) serão movidos para a Lixeira.",
    confirmDataTrashed: "Sua pasta de dados {folder} também será movida para a Lixeira.",
    confirmDataKept: "Sua pasta de dados será mantida.",
    confirmPackage:
      "O gerenciador de pacotes removerá o app depois que você digitar a senha de administrador.",
    packageFailed:
      "O gerenciador de pacotes não conseguiu remover o Psyche ({detail}). Para concluir, execute: {command}",
  },
  es: {
    stopGateway: "Detener y desactivar el servicio Gateway de Psyche",
    stopHelper: "Detener el asistente de Psyche y desactivar la apertura al iniciar sesión",
    stopDesktops:
      "Detener la pantalla virtual y los contenedores del escritorio separado de Psyche",
    itemService: "Archivo del servicio Gateway",
    itemAutostart: "Entrada de apertura al iniciar sesión",
    itemLauncher: "Entrada del menú de aplicaciones",
    itemSettings: "Ajustes de la aplicación",
    itemCaches: "Cachés",
    itemHelperState: "Estado del asistente",
    itemPrevious: "Versión anterior guardada para volver atrás",
    itemData: "Datos de Psyche",
    itemApp: "AppImage de Psyche",
    warnOtherUnit:
      "El servicio psyche-gateway pertenece a otra copia de Psyche o a la herramienta de línea de comandos; se deja como está",
    warnPackage:
      "Psyche vino de un paquete. Quitarlo pide tu contraseña de administrador y ejecuta: {command}",
    confirmTitle: "¿Desinstalar Psyche?",
    confirmCancel: "Cancelar",
    confirmUninstall: "Desinstalar",
    confirmDeleteData: "Borrar los datos y desinstalar",
    confirmItems: "{count} elemento(s) se moverán a la papelera.",
    confirmDataTrashed: "Tu carpeta de datos {folder} también se moverá a la papelera.",
    confirmDataKept: "Tu carpeta de datos se conserva.",
    confirmPackage:
      "El gestor de paquetes quitará la app cuando escribas tu contraseña de administrador.",
    packageFailed:
      "El gestor de paquetes no pudo quitar Psyche ({detail}). Para terminar, ejecuta: {command}",
  },
};

export function linuxUninstallText(locale: string): LinuxUninstallText {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? "en";
  return LINUX_UNINSTALL_TEXT[lang] ?? EN;
}

/** Replaces `{name}` placeholders; a name with no value is left as written. */
export function fillText(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  );
}
