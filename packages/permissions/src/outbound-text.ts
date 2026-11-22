/**
 * The outbound check's own words, in every shipped language (security §3.9): the notice that
 * replaces a withheld value in the owner's chat, the notification for a held message, and the note
 * the conversation gets. The Gateway has no React catalogue, so they live here, keyed by the owner's
 * `ui.language` (or the Mac's language when that is "system"). `{channel}` and `{kinds}` are filled
 * in; `{kinds}` lists value kinds as identifiers (`card_number`), never values.
 */

export interface OutboundText {
  notice: string;
  heldTitle: string;
  heldBody: string;
  threadNote: string;
}

export const OUTBOUND_TEXT: Readonly<Record<string, OutboundText>> = {
  en: {
    notice: "[withheld: open Psyche to see it]",
    heldTitle: "A message was held back",
    heldBody:
      "Psyche did not send a {channel} message because it held a private value. Open Psyche to see it.",
    threadNote:
      "Psyche did not send the last {channel} message because it held a private value ({kinds}). Tell the owner to send it themselves, or leave the value out.",
  },
  ar: {
    notice: "[محجوب: افتح Psyche لرؤيته]",
    heldTitle: "تم حجب رسالة",
    heldBody: "لم يرسل Psyche رسالة {channel} لأنها تحتوي على بيانات خاصة. افتح Psyche لرؤيتها.",
    threadNote:
      "لم يرسل Psyche آخر رسالة {channel} لأنها تحتوي على بيانات خاصة ({kinds}). اطلب من المالك إرسالها بنفسه، أو احذف هذه البيانات.",
  },
  de: {
    notice: "[zurückgehalten: in Psyche ansehen]",
    heldTitle: "Eine Nachricht wurde zurückgehalten",
    heldBody:
      "Psyche hat eine {channel}-Nachricht nicht gesendet, weil sie einen privaten Wert enthielt. Öffne Psyche, um sie zu sehen.",
    threadNote:
      "Psyche hat die letzte {channel}-Nachricht nicht gesendet, weil sie einen privaten Wert enthielt ({kinds}). Bitte den Besitzer, sie selbst zu senden, oder lass den Wert weg.",
  },
  es: {
    notice: "[retenido: abre Psyche para verlo]",
    heldTitle: "Se retuvo un mensaje",
    heldBody:
      "Psyche no envió un mensaje de {channel} porque contenía un dato privado. Abre Psyche para verlo.",
    threadNote:
      "Psyche no envió el último mensaje de {channel} porque contenía un dato privado ({kinds}). Pide al propietario que lo envíe él mismo o quita el dato.",
  },
  fr: {
    notice: "[retenu : ouvrez Psyche pour le voir]",
    heldTitle: "Un message a été retenu",
    heldBody:
      "Psyche n’a pas envoyé un message {channel}, car il contenait une donnée privée. Ouvrez Psyche pour le voir.",
    threadNote:
      "Psyche n’a pas envoyé le dernier message {channel}, car il contenait une donnée privée ({kinds}). Demandez au propriétaire de l’envoyer lui-même, ou retirez la donnée.",
  },
  hi: {
    notice: "[रोका गया: देखने के लिए Psyche खोलें]",
    heldTitle: "एक संदेश रोका गया",
    heldBody: "Psyche ने {channel} संदेश नहीं भेजा, क्योंकि उसमें निजी जानकारी थी। देखने के लिए Psyche खोलें।",
    threadNote:
      "Psyche ने पिछला {channel} संदेश नहीं भेजा, क्योंकि उसमें निजी जानकारी थी ({kinds})। मालिक से कहें कि वे इसे खुद भेजें, या वह जानकारी हटा दें।",
  },
  it: {
    notice: "[trattenuto: apri Psyche per vederlo]",
    heldTitle: "Un messaggio è stato trattenuto",
    heldBody:
      "Psyche non ha inviato un messaggio {channel} perché conteneva un dato privato. Apri Psyche per vederlo.",
    threadNote:
      "Psyche non ha inviato l’ultimo messaggio {channel} perché conteneva un dato privato ({kinds}). Chiedi al proprietario di inviarlo di persona, oppure togli il dato.",
  },
  ja: {
    notice: "[保留: Psyche を開いて確認]",
    heldTitle: "メッセージを保留しました",
    heldBody:
      "非公開の情報が含まれていたため、Psyche は {channel} のメッセージを送信しませんでした。Psyche を開いて確認してください。",
    threadNote:
      "非公開の情報（{kinds}）が含まれていたため、Psyche は直前の {channel} メッセージを送信しませんでした。所有者に自分で送るよう伝えるか、その情報を外してください。",
  },
  ko: {
    notice: "[보류됨: Psyche에서 확인하세요]",
    heldTitle: "메시지를 보류했습니다",
    heldBody:
      "비공개 정보가 포함되어 있어 Psyche가 {channel} 메시지를 보내지 않았습니다. Psyche를 열어 확인하세요.",
    threadNote:
      "비공개 정보({kinds})가 포함되어 있어 Psyche가 마지막 {channel} 메시지를 보내지 않았습니다. 소유자에게 직접 보내도록 안내하거나 해당 정보를 빼세요.",
  },
  pt: {
    notice: "[retido: abra o Psyche para ver]",
    heldTitle: "Uma mensagem foi retida",
    heldBody:
      "O Psyche não enviou uma mensagem de {channel} porque ela continha um dado privado. Abra o Psyche para ver.",
    threadNote:
      "O Psyche não enviou a última mensagem de {channel} porque ela continha um dado privado ({kinds}). Peça ao proprietário que a envie ele mesmo ou retire o dado.",
  },
  zh: {
    notice: "[已保留：打开 Psyche 查看]",
    heldTitle: "一条消息已被保留",
    heldBody: "这条 {channel} 消息含有私密信息，Psyche 没有发送。请打开 Psyche 查看。",
    threadNote:
      "上一条 {channel} 消息含有私密信息（{kinds}），Psyche 没有发送。请让主人自己发送，或去掉这项信息。",
  },
};

/** The strings for a language tag ("de", "pt-BR", "system" → `fallback`), English when none ships. */
export function outboundText(language: string | undefined, fallback?: string): OutboundText {
  const pick = (tag: string | undefined) => tag?.split(/[-_]/)[0]?.toLowerCase();
  const lang = language === undefined || language === "system" ? pick(fallback) : pick(language);
  return OUTBOUND_TEXT[lang ?? "en"] ?? (OUTBOUND_TEXT.en as OutboundText);
}

/** Fills `{channel}` and `{kinds}`. */
export function fillOutboundText(
  template: string,
  values: { channel: string; kinds?: readonly string[] },
): string {
  return template
    .replaceAll("{channel}", values.channel)
    .replaceAll("{kinds}", (values.kinds ?? []).join(", "));
}
