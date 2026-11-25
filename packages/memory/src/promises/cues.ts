/**
 * The no-model prefilter of the promise lane (design 3.2 step 1). A sentence is a candidate only
 * when one language's lists find both a commitment cue ("I'll", "voy a", "ich schicke") and an
 * object or time cue, and the same sentence has no hedge ("I'll try", "maybe") and is not a
 * question. Per-language lists for the 11 shipped message locales. This is a cheap gate in front
 * of the model and the whole judge in rules-only mode, so it errs towards silence: a missed
 * promise costs a prompt, a false one costs the owner's trust.
 */

import { sha256 } from "../graph/normalize.ts";

export type CueLang = "en" | "es" | "de" | "fr" | "it" | "pt" | "ja" | "zh" | "ko" | "ar" | "hi";

interface LangCues {
  /** Whether `\b`-style word edges apply (false for scripts written without spaces). */
  spaced: boolean;
  /** First-person future or an offer to do it: the commitment cue. */
  commit: string[];
  /** An answer that accepts a request; it needs no object cue of its own in model mode. */
  accept: string[];
  /** Verbs, nouns and times: the object or time cue. */
  object: string[];
  /** "I'll try", "maybe", "if I get time": not a promise. */
  hedge: string[];
  /** Question endings besides a question mark. */
  question: string[];
}

const WEEKDAYS_EN =
  "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri";

const CUES: Record<CueLang, LangCues> = {
  en: {
    spaced: true,
    commit: [
      "i'll",
      "i will",
      "i'm going to",
      "i am going to",
      "i'm gonna",
      "let me (?:get|send|share|check|look|draft|write|find|book|set|put|follow|circle|review|confirm)",
      "i can do",
      "i promise",
      "i'll make sure",
      "i'd be happy to",
      "will do",
      "consider it done",
    ],
    accept: ["will do", "consider it done", "i'm on it"],
    object: [
      "today",
      "tonight",
      "tomorrow",
      "this (?:morning|afternoon|evening|week|weekend)",
      "next (?:week|month)",
      `by (?:${WEEKDAYS_EN}|eod|cob|end of (?:day|week|month)|noon|tomorrow|tonight|\\d)`,
      `on (?:${WEEKDAYS_EN})`,
      `(?:${WEEKDAYS_EN})`,
      "eod",
      "end of (?:day|week)",
      "in (?:a|an|\\d+) (?:minute|hour|day|week)s?",
      "later",
      "asap",
      "\\d{1,2}(?::\\d\\d)?\\s?(?:am|pm)",
      "\\d{4}-\\d{2}-\\d{2}",
      "(?:send|share|forward|email|e-mail|reply|respond|call|ping|book|schedule|finish|draft|write|update|review|confirm|follow up|get back|circle back|introduce|pay|submit|prepare|fix|deliver|set up|put together|look into|look at|check|bring|sign|upload|post)\\p{L}*",
    ],
    hedge: [
      "try(?:ing)? to",
      "i'll try",
      "i will try",
      "might",
      "maybe",
      "perhaps",
      "probably",
      "possibly",
      "if i (?:can|get|have|find|remember|manage)",
      "if (?:time|possible|i'm able)",
      "hopefully",
      "i'll see",
      "let's see",
      "i should",
      "i could",
      "i may",
      "not sure",
      "i'd like to",
      "someday",
      "at some point",
      "depending",
      "won't",
      "will not",
      "not going to",
      "can't",
      "don't",
    ],
    question: [],
  },
  es: {
    spaced: true,
    commit: [
      "voy a",
      "(?:te|se|le) (?:lo |la )?(?:mando|envío|envio|paso|escribo|llamo|aviso)",
      "(?:lo|la) (?:mando|envío|envio|haré|hare)",
      "(?:lo |la )?haré",
      "(?:enviaré|mandaré|llamaré|escribiré|revisaré|confirmaré|compartiré|prepararé|terminaré|responderé|reservaré|pagaré)",
      "te aviso",
      "cuenta con ello",
      "me encargo",
      "yo me ocupo",
      "prometo",
    ],
    accept: ["cuenta con ello", "me encargo", "yo me ocupo"],
    object: [
      "hoy",
      "mañana",
      "esta (?:mañana|tarde|noche|semana)",
      "la próxima semana",
      "el (?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)",
      "(?:lunes|martes|miércoles|miercoles|jueves|viernes)",
      "antes del?",
      "más tarde",
      "a las \\d",
      "\\d{4}-\\d{2}-\\d{2}",
      "(?:envi|mand|compart|llam|escrib|revis|confirm|respond|prepar|termin|reserv|pag)\\p{L}*",
      "(?:documento|archivo|informe|contrato|correo|factura|presupuesto|reunión|presentación|propuesta)\\p{L}*",
    ],
    hedge: [
      "intentar\\p{L}*",
      "trataré",
      "tratar\\p{L}*",
      "a lo mejor",
      "quizá",
      "quizás",
      "quizas",
      "tal vez",
      "si puedo",
      "si tengo tiempo",
      "igual",
      "probablemente",
      "ojalá",
      "puede que",
      "veré si",
      "ya veremos",
      "no voy a",
      "no (?:te|lo|la) ",
    ],
    question: [],
  },
  de: {
    spaced: true,
    commit: [
      "ich (?:werde|schicke|sende|melde|rufe|mache|kümmere|besorge|erledige|bringe|leite|gebe|buche|bestätige|prüfe|antworte|teile|reiche|übernehme)",
      "mach(?:e)? ich",
      "wird gemacht",
      "versprochen",
    ],
    accept: ["wird gemacht", "mach ich", "mache ich"],
    object: [
      "heute",
      "morgen",
      "heute abend",
      "(?:diese|nächste|naechste) woche",
      "bis (?:montag|dienstag|mittwoch|donnerstag|freitag|ende|morgen|\\d)",
      "am (?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)",
      "(?:montag|dienstag|mittwoch|donnerstag|freitag)",
      "später",
      "gleich",
      "um \\d",
      "\\d{4}-\\d{2}-\\d{2}",
      "(?:schick|send|teil|ruf|buch|bestätig|prüf|antwort|erledig|bericht|datei|vertrag|rechnung|unterlagen|folien|angebot|dokument|mail)\\p{L}*",
    ],
    hedge: [
      "versuche\\p{L}*",
      "versuchen",
      "vielleicht",
      "eventuell",
      "möglicherweise",
      "falls ich",
      "wenn ich (?:zeit|kann)",
      "wahrscheinlich",
      "hoffentlich",
      "mal sehen",
      "könnte",
      "würde ich",
      "nicht",
    ],
    question: [],
  },
  fr: {
    spaced: true,
    commit: [
      "je vais",
      "je (?:te |t'|vous )(?:l'|le |la |les )?(?:envoie|enverrai|rappelle|rappellerai|recontacte|recontacterai)",
      "je (?:ferai|enverrai|appellerai|confirmerai|préparerai|répondrai|reviens vers|m'en occupe|m'en charge)",
      "je le fais",
      "je promets",
      "promis",
      "c'est noté",
    ],
    accept: ["je m'en occupe", "je m'en charge", "promis", "c'est noté"],
    object: [
      "aujourd'hui",
      "demain",
      "ce (?:matin|soir)",
      "cet après-midi",
      "cette semaine",
      "la semaine prochaine",
      "avant (?:lundi|mardi|mercredi|jeudi|vendredi|demain)",
      "d'ici",
      "(?:lundi|mardi|mercredi|jeudi|vendredi)",
      "plus tard",
      "à \\d+ ?h",
      "\\d{4}-\\d{2}-\\d{2}",
      "(?:envoy|appel|confirm|répond|prépar|réserv|document|fichier|contrat|facture|devis|mail|rapport|présentation)\\p{L}*",
    ],
    hedge: [
      "j'essaie\\p{L}*",
      "essayer",
      "peut-être",
      "si je peux",
      "si j'ai le temps",
      "probablement",
      "je verrai",
      "on verra",
      "éventuellement",
      "sans doute",
      "j'espère",
      "pas",
    ],
    question: [],
  },
  it: {
    spaced: true,
    commit: [
      "ti (?:lo |la )?(?:mando|invio|scrivo|chiamo|richiamo|faccio sapere)",
      "(?:manderò|invierò|chiamerò|scriverò|confermerò|preparerò|risponderò|farò)",
      "me ne occupo",
      "ci penso io",
      "lo faccio",
      "prometto",
      "conta su di me",
    ],
    accept: ["ci penso io", "me ne occupo", "conta su di me"],
    object: [
      "oggi",
      "domani",
      "stasera",
      "questa (?:mattina|sera|settimana)",
      "la prossima settimana",
      "entro",
      "(?:lunedì|martedì|mercoledì|giovedì|venerdì)",
      "più tardi",
      "alle \\d",
      "\\d{4}-\\d{2}-\\d{2}",
      "(?:mand|invi|scriv|chiam|conferm|prepar|rispond|prenot|document|file|contratto|fattura|preventivo|mail|rapporto|presentazione)\\p{L}*",
    ],
    hedge: [
      "proverò",
      "cercherò di",
      "forse",
      "magari",
      "se riesco",
      "se posso",
      "se ho tempo",
      "probabilmente",
      "vedrò",
      "speriamo",
    ],
    question: [],
  },
  pt: {
    spaced: true,
    commit: [
      "vou",
      "(?:te|lhe) (?:mando|envio|escrevo|ligo)",
      "(?:enviarei|mandarei|ligarei|escreverei|confirmarei|prepararei|responderei|farei)",
      "eu cuido",
      "deixa comigo",
      "pode deixar",
      "prometo",
      "conte comigo",
    ],
    accept: ["deixa comigo", "pode deixar", "conte comigo", "eu cuido"],
    object: [
      "hoje",
      "amanhã",
      "esta (?:manhã|tarde|noite|semana)",
      "próxima semana",
      "até",
      "(?:segunda|terça|quarta|quinta|sexta)",
      "mais tarde",
      "às \\d",
      "\\d{4}-\\d{2}-\\d{2}",
      "(?:envi|mand|lig|escrev|confirm|prepar|respond|reserv|document|arquivo|contrato|fatura|orçamento|e-mail|relatório|apresentação)\\p{L}*",
    ],
    hedge: [
      "tentarei",
      "tentar",
      "talvez",
      "se der",
      "se puder",
      "se tiver tempo",
      "provavelmente",
      "vamos ver",
      "quem sabe",
      "espero",
      "acho que",
    ],
    question: [],
  },
  ja: {
    spaced: false,
    commit: [
      "します",
      "しておきます",
      "送ります",
      "やります",
      "連絡します",
      "確認します",
      "お送りします",
      "返信します",
      "お返事します",
      "準備します",
      "手配します",
      "共有します",
      "提出します",
      "約束します",
      "任せてください",
    ],
    accept: ["任せてください"],
    object: [
      "今日",
      "明日",
      "今夜",
      "今週",
      "来週",
      "[月火水木金土日]曜",
      "まで",
      "後で",
      "\\d+時",
      "資料",
      "ファイル",
      "メール",
      "契約",
      "請求書",
      "見積",
      "報告",
      "レポート",
      "\\d{4}-\\d{2}-\\d{2}",
    ],
    hedge: [
      "かもしれ",
      "たぶん",
      "多分",
      "できれば",
      "時間があれば",
      "やってみ",
      "試してみ",
      "頑張り",
      "予定です",
    ],
    question: ["(?:ます|ません|です)か[。]?$", "でしょうか[。]?$"],
  },
  zh: {
    spaced: false,
    commit: [
      "我[\\u4e00-\\u9fff]{0,4}?会",
      "我来",
      "我将",
      "我马上",
      "我负责",
      "我答应",
      "包在我身上",
      "我一定",
      "交给我",
      "我发给你",
      "我给你发",
      "我回复",
      "我确认",
      "我准备",
    ],
    accept: ["包在我身上", "交给我"],
    object: [
      "今天",
      "明天",
      "今晚",
      "本周",
      "这周",
      "下周",
      "周[一二三四五六日天]",
      "星期[一二三四五六日天]",
      "之前",
      "稍后",
      "晚点",
      "\\d+点",
      "发",
      "送",
      "回复",
      "确认",
      "准备",
      "预订",
      "文件",
      "合同",
      "发票",
      "报价",
      "邮件",
      "报告",
      "方案",
      "资料",
      "\\d{4}-\\d{2}-\\d{2}",
    ],
    hedge: [
      "不会",
      "不能",
      "不想",
      "试试",
      "尝试",
      "也许",
      "可能",
      "或许",
      "如果有时间",
      "看情况",
      "尽量",
      "争取",
      "应该",
    ],
    question: ["吗[。]?$"],
  },
  ko: {
    spaced: false,
    commit: [
      "보낼게",
      "보내겠습니다",
      "할게",
      "하겠습니다",
      "드리겠습니다",
      "연락드리겠습니다",
      "확인하겠습니다",
      "해둘게",
      "준비하겠습니다",
      "답장하겠습니다",
      "약속",
    ],
    accept: ["맡겨"],
    object: [
      "오늘",
      "내일",
      "이번 주",
      "다음 주",
      "[월화수목금토일]요일",
      "까지",
      "나중에",
      "\\d+시",
      "파일",
      "자료",
      "계약",
      "청구서",
      "견적",
      "메일",
      "보고서",
      "답장",
      "\\d{4}-\\d{2}-\\d{2}",
    ],
    hedge: [
      "해볼게",
      "해보겠",
      "아마",
      "혹시",
      "할 수 있으면",
      "시간이 되면",
      "노력",
      "가능하면",
      "일지도",
    ],
    question: ["(?:나요|까요|니까)[.]?$"],
  },
  ar: {
    spaced: false,
    commit: [
      "سأرسل",
      "سوف أرسل",
      "سأتصل",
      "سأرد",
      "سأؤكد",
      "سأقوم",
      "سأحضر",
      "سأكتب",
      "سأحجز",
      "سأراجع",
      "سأشارك",
      "سأجهز",
      "أعدك",
    ],
    accept: [],
    object: [
      "اليوم",
      "غدا",
      "غداً",
      "الليلة",
      "هذا الأسبوع",
      "الأسبوع القادم",
      "يوم (?:الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت|الأحد)",
      "قبل",
      "لاحقا",
      "لاحقاً",
      "ملف",
      "عقد",
      "فاتورة",
      "عرض",
      "تقرير",
      "رسالة",
      "بريد",
      "مستند",
      "\\d{4}-\\d{2}-\\d{2}",
    ],
    hedge: ["سأحاول", "ربما", "إن استطعت", "إذا كان لدي وقت", "أتمنى", "إن شاء الله"],
    question: [],
  },
  hi: {
    spaced: false,
    commit: [
      "भेजूंगा",
      "भेजूँगा",
      "भेजूंगी",
      "भेजूँगी",
      "करूंगा",
      "करूँगा",
      "करूंगी",
      "करूँगी",
      "कर दूंगा",
      "कर दूंगी",
      "बता दूंगा",
      "बता दूंगी",
      "वादा",
    ],
    accept: [],
    object: [
      "आज",
      "कल",
      "इस हफ्ते",
      "अगले हफ्ते",
      "सोमवार",
      "मंगलवार",
      "बुधवार",
      "गुरुवार",
      "शुक्रवार",
      "शनिवार",
      "रविवार",
      "तक",
      "बाद में",
      "फाइल",
      "दस्तावेज",
      "अनुबंध",
      "रिपोर्ट",
      "ईमेल",
      "मेल",
      "भेज",
      "\\d{4}-\\d{2}-\\d{2}",
    ],
    hedge: ["कोशिश", "शायद", "अगर समय", "हो सके तो", "उम्मीद"],
    question: [],
  },
};

export const CUE_LANGS = Object.keys(CUES) as readonly CueLang[];

const WORD_L = "(?<![\\p{L}\\p{N}_])";
const WORD_R = "(?![\\p{L}\\p{N}_])";

function compile(patterns: readonly string[], spaced: boolean): RegExp | undefined {
  if (patterns.length === 0) return undefined;
  const body = patterns.map((p) => `(?:${p})`).join("|");
  return new RegExp(spaced ? `${WORD_L}(?:${body})${WORD_R}` : `(?:${body})`, "iu");
}

interface Compiled {
  commit: RegExp | undefined;
  accept: RegExp | undefined;
  object: RegExp | undefined;
  hedge: RegExp | undefined;
  question: RegExp | undefined;
}

const COMPILED: Record<CueLang, Compiled> = Object.fromEntries(
  CUE_LANGS.map((lang) => {
    const c = CUES[lang];
    return [
      lang,
      {
        commit: compile(c.commit, c.spaced),
        accept: compile(c.accept, c.spaced),
        object: compile(c.object, c.spaced),
        hedge: compile(c.hedge, c.spaced),
        question: c.question.length === 0 ? undefined : new RegExp(c.question.join("|"), "u"),
      } satisfies Compiled,
    ];
  }),
) as Record<CueLang, Compiled>;

/** Curly quotes and compatibility forms folded, so "I’ll" and "I'll" are the same cue. */
export function foldCue(text: string): string {
  return text.normalize("NFKC").replace(/[’‘`´]/g, "'");
}

export interface SentenceVerdict {
  /** The language whose lists matched. */
  lang: CueLang;
  /** The commitment phrase as written, lowercased: the cue the feedback is keyed on. */
  cue: string;
  /** Matched the accepted-request list ("will do"). */
  accept: boolean;
  /** Where the commitment cue starts in the folded sentence. */
  at: number;
}

const QUESTION_MARK = /[?？؟]\s*["'”’)\]]*$/u;

/**
 * Whether one sentence is a candidate, with the cue that made it one. `cuesOff` holds cue phrases
 * the owner's feedback switched off (`promises.state.cuesOff`). Null means no.
 */
export function judgeSentence(
  sentence: string,
  options: { cuesOff?: ReadonlySet<string>; requireObject?: boolean } = {},
): SentenceVerdict | null {
  const text = foldCue(sentence).trim();
  if (text.length < 4 || QUESTION_MARK.test(text)) return null;
  // A hedge or a question in any language ends it: a mixed-language sentence is not worth a prompt.
  for (const lang of CUE_LANGS) {
    const c = COMPILED[lang];
    if (c.hedge?.test(text) === true || c.question?.test(text) === true) return null;
  }
  for (const lang of CUE_LANGS) {
    const c = COMPILED[lang];
    const commit = c.commit?.exec(text);
    if (commit === null || commit === undefined) continue;
    const cue = commit[0].toLowerCase();
    if (options.cuesOff?.has(cue) === true) continue;
    const accept = c.accept?.test(commit[0]) === true;
    const needObject = options.requireObject === true || !accept;
    if (needObject && c.object?.test(text) !== true) continue;
    return { lang, cue, accept, at: commit.index };
  }
  return null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** Sentences of a text, in order. Newlines end a sentence too (mail lines, notes bullets). */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    for (const s of segmenter.segment(line)) {
      const t = s.segment.replace(/\s+/g, " ").trim();
      if (t !== "") out.push(t);
    }
  }
  return out;
}

export const SNIPPET_MAX_CHARS = 600;
/** At most this many snippets from one item (a mail full of "I'll" lines is a flood, not a list). */
export const MAX_CANDIDATES_PER_ITEM = 3;

export interface Candidate {
  /** The promise sentence. */
  sentence: string;
  /** The sentence and one sentence each side, at most 600 characters. */
  snippet: string;
  cue: string;
  lang: CueLang;
}

/**
 * The candidates in one item's text. `text` must already be redacted: the 600-character cut is
 * made here, and cutting an unredacted text would let a secret straddle it (psyche-permissions 3f).
 * Two candidates in neighbouring sentences share a snippet, so the model reads them once.
 */
export function findCandidates(
  text: string,
  options: { cuesOff?: ReadonlySet<string>; max?: number } = {},
): Candidate[] {
  const sentences = sentencesOf(text);
  const out: Candidate[] = [];
  let coveredTo = -1;
  const max = options.max ?? MAX_CANDIDATES_PER_ITEM;
  for (const [i, sentence] of sentences.entries()) {
    // One item cannot cost more than a few snippets, however many cue sentences it holds.
    if (out.length >= max) break;
    const verdict = judgeSentence(sentence, options);
    if (verdict === null || i <= coveredTo) continue;
    const parts = [sentences[i - 1], sentence, sentences[i + 1]].filter(
      (s): s is string => s !== undefined,
    );
    let snippet = parts.join(" ");
    if (snippet.length > SNIPPET_MAX_CHARS) {
      // Drop the neighbours first; only a single very long sentence is cut.
      snippet = sentence.slice(0, SNIPPET_MAX_CHARS);
    } else {
      coveredTo = i + 1;
    }
    out.push({ sentence, snippet, cue: verdict.cue, lang: verdict.lang });
  }
  return out;
}

/** `sha256(source|threadId)`: the only form in which a muted thread is stored. */
export const threadHash = (source: string, threadId: string): string =>
  sha256(`${source}|${threadId}`);
