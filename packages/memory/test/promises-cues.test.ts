import { describe, expect, it } from "vitest";
import { findCandidates, judgeSentence, SNIPPET_MAX_CHARS } from "../src/promises/cues.ts";
import { parseDue, resolveDue } from "../src/promises/due-text.ts";

/**
 * Cue table (design 3.2 step 1). Every row is a sentence and whether the prefilter passes it. The
 * "must not" rows are the near-misses a prompt would be wasted on, or worse, a false promise
 * shown to the owner: hedges, questions, past tense, requests nobody accepted, promises to
 * someone who is not in the conversation. Each language has the same five kinds of row.
 */
const MUST_PASS: [string, string][] = [
  ["en", "I'll send the deck on Friday."],
  ["en", "I will send you the signed contract tomorrow."],
  ["en", "Let me get you the numbers by EOD."],
  ["en", "I’ll review the draft tonight."],
  ["en", "Will do, I'll forward the invoice today."],
  ["en", "Sure, will do."],
  ["es", "Te envío el informe el viernes."],
  ["es", "Voy a mandar el contrato mañana."],
  ["es", "Enviaré la factura esta tarde."],
  ["es", "Cuenta con ello."],
  ["de", "Ich schicke dir die Folien morgen."],
  ["de", "Ich werde den Vertrag bis Freitag bestätigen."],
  ["de", "Mach ich."],
  ["fr", "Je t'envoie le contrat demain."],
  ["it", "Ti mando il contratto domani."],
  ["pt", "Vou enviar o contrato amanhã."],
  ["ja", "明日までに資料を送ります。"],
  ["zh", "我明天会把合同发给你。"],
  ["ko", "내일까지 파일을 보내겠습니다."],
  ["ar", "سأرسل الملف غدا."],
  ["hi", "मैं कल फाइल भेजूंगा।"],
];

const MUST_NOT_PASS: [string, string, string][] = [
  // hedged or conditional
  ["en", "I'll try to send the deck on Friday.", "hedge: try"],
  ["en", "Maybe I'll send the deck Friday.", "hedge: maybe"],
  ["en", "If I get time I'll send the deck on Friday.", "hedge: if"],
  ["en", "I might send the contract tomorrow.", "hedge: might"],
  ["en", "I'll see if I can send it on Friday.", "hedge: see"],
  // questions
  ["en", "Shall I send the deck on Friday?", "question"],
  ["en", "Will you send the contract tomorrow?", "question, no first person"],
  ["en", "I'll send the deck on Friday, right?", "question"],
  // past tense
  ["en", "I sent the deck on Friday.", "past"],
  ["en", "I called Sam yesterday about the contract.", "past"],
  ["en", "She told me she'd send the report tomorrow.", "third person"],
  // a request nobody accepted
  ["en", "Can you send the deck by Friday?", "unaccepted ask"],
  ["en", "Please send me the contract tomorrow.", "unaccepted ask"],
  // no object or time
  ["en", "I'll be there.", "no object"],
  // spanish
  ["es", "Intentaré enviar el informe el viernes.", "hedge"],
  ["es", "Quizás te mando el contrato mañana.", "hedge"],
  ["es", "¿Te envío el informe el viernes?", "question"],
  ["es", "¿Me lo puedes enviar el viernes?", "question, ask"],
  ["es", "Ayer le envié el informe.", "past"],
  ["es", "Dijo que lo enviará mañana.", "third person"],
  // german
  ["de", "Ich versuche, dir die Folien morgen zu schicken.", "hedge"],
  ["de", "Ich schicke dir die Folien vielleicht morgen.", "hedge"],
  ["de", "Soll ich dir die Folien morgen schicken?", "question"],
  ["de", "Schickst du mir die Folien bis Freitag?", "question, ask"],
  ["de", "Ich habe die Folien gestern geschickt.", "past"],
  ["de", "Er schickt die Folien morgen.", "third person"],
  // other languages: one hedge, one question each
  ["fr", "Peut-être que je t'envoie le contrat demain.", "hedge"],
  ["it", "Forse ti mando il contratto domani.", "hedge"],
  ["pt", "Talvez eu vou enviar o contrato amanhã.", "hedge"],
  ["ja", "明日までに資料を送りますか？", "question"],
  ["ja", "たぶん明日までに資料を送ります。", "hedge"],
  ["zh", "我明天会把合同发给你吗？", "question"],
  ["zh", "我明天也许会把合同发给你。", "hedge"],
  ["ko", "내일까지 파일을 보내겠습니다?", "question"],
  ["ar", "ربما سأرسل الملف غدا.", "hedge"],
  ["hi", "शायद मैं कल फाइल भेजूंगा।", "hedge"],
];

describe("judgeSentence: promises", () => {
  it.each(MUST_PASS)("%s: %s", (_lang, sentence) => {
    expect(judgeSentence(sentence)).not.toBeNull();
  });
});

describe("judgeSentence: near-misses", () => {
  it.each(MUST_NOT_PASS)("%s: %s (%s)", (_lang, sentence) => {
    expect(judgeSentence(sentence)).toBeNull();
  });

  it("is not fooled by a cue inside a longer word", () => {
    expect(judgeSentence("The illness was bad on Friday.")).toBeNull();
    expect(judgeSentence("Hello, Friday is the day we met.")).toBeNull();
  });

  it("a switched-off cue phrase no longer passes (promises.state.cuesOff)", () => {
    expect(judgeSentence("I'll send the deck on Friday.")).not.toBeNull();
    expect(
      judgeSentence("I'll send the deck on Friday.", { cuesOff: new Set(["i'll"]) }),
    ).toBeNull();
  });

  it("an accepted request needs no object in model mode, but rules-only requires one", () => {
    expect(judgeSentence("Sure, will do.")).not.toBeNull();
    expect(judgeSentence("Sure, will do.", { requireObject: true })).toBeNull();
  });
});

describe("findCandidates: snippets", () => {
  it("cuts a snippet of the sentence and one each side, at most 600 characters", () => {
    const text =
      "Thanks for the call. I'll send the deck on Friday. Talk soon. Unrelated last line.";
    const [c, ...rest] = findCandidates(text);
    expect(rest).toEqual([]);
    expect(c?.snippet).toBe("Thanks for the call. I'll send the deck on Friday. Talk soon.");
    expect(c?.sentence).toBe("I'll send the deck on Friday.");
  });

  it("a sentence with no candidate near it yields nothing, so no model call is made", () => {
    expect(findCandidates("Lunch was great. See you at the party. Thanks again.")).toEqual([]);
  });

  it("a very long neighbour is dropped and a very long sentence is cut at 600", () => {
    const long = `I'll send the deck on Friday ${"and then some words ".repeat(60)}.`;
    const [c] = findCandidates(`${"Filler. ".repeat(100)}${long}`);
    expect(c?.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });
});

describe("parseDue: the code resolves dates", () => {
  const SENT = Date.parse("2026-11-24T10:12:00Z"); // a Tuesday
  const at = (p: string | null, tz = "UTC") => parseDue(p, SENT, tz);

  it("a bare day means 17:00 that day; EOD 17:00; tonight 21:00", () => {
    expect(at("by Friday")).toMatchObject({ at: "2026-11-27T17:00:00.000Z", kind: "explicit" });
    expect(at("EOD")).toMatchObject({ at: "2026-11-24T17:00:00.000Z" });
    expect(at("tonight")).toMatchObject({ at: "2026-11-24T21:00:00.000Z" });
    expect(at("tomorrow")).toMatchObject({ at: "2026-11-25T17:00:00.000Z" });
    expect(at("hasta el viernes")).toMatchObject({ at: "2026-11-27T17:00:00.000Z" });
    expect(at("bis Freitag")).toMatchObject({ at: "2026-11-27T17:00:00.000Z" });
  });

  it("works in the owner's zone", () => {
    // 17:00 in New York (UTC-5 in November) is 22:00Z.
    expect(at("Friday", "America/New_York")).toMatchObject({ at: "2026-11-27T22:00:00.000Z" });
  });

  it("next week is Friday of next week, inferred at 0.5; soon gives no date", () => {
    expect(at("next week")).toMatchObject({
      at: "2026-12-04T17:00:00.000Z",
      kind: "inferred",
      confidence: 0.5,
    });
    expect(at("soon")).toMatchObject({ at: null, kind: "none" });
    expect(at(null)).toMatchObject({ at: null });
    expect(at("an ISO date 2026-12-01")).toMatchObject({ at: "2026-12-01T17:00:00.000Z" });
  });

  it("an explicit clock time rides on the day", () => {
    expect(at("Friday at 3pm")).toMatchObject({ at: "2026-11-27T15:00:00.000Z" });
  });
});

describe("resolveDue: the parser wins over the model", () => {
  const SENT = Date.parse("2026-11-24T10:12:00Z");
  const due = (over: Partial<Parameters<typeof resolveDue>[0]>) =>
    resolveDue(
      { text: "by Friday", date: null, time: null, kind: "explicit", confidence: 0.9, ...over },
      SENT,
      "UTC",
    );

  it("agreeing dates keep the lower confidence", () => {
    expect(due({ date: "2026-11-27", confidence: 0.7 })).toMatchObject({
      at: "2026-11-27T17:00:00.000Z",
      confidence: 0.7,
    });
  });

  it("a disagreeing model date loses, and confidence drops to 0.5 at most", () => {
    expect(due({ date: "2026-12-15", confidence: 0.95 })).toMatchObject({
      at: "2026-11-27T17:00:00.000Z",
      confidence: 0.5,
    });
  });

  it("with no readable phrase the model's date is only inferred, 0.5 at most", () => {
    expect(due({ text: "after the holidays", date: "2026-12-28" })).toMatchObject({
      at: "2026-12-28T17:00:00.000Z",
      kind: "inferred",
      confidence: 0.5,
    });
  });

  it("a date far outside the window is junk", () => {
    expect(due({ text: null, date: "2031-01-01" })).toMatchObject({ at: null, kind: "none" });
    expect(due({ text: null, date: "2020-01-01" })).toMatchObject({ at: null });
  });
});
