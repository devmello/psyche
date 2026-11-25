import { describe, expect, it } from "vitest";
import { looksLikeWork } from "../src/compose/user-profile.ts";
import { learnGate } from "../src/compose/user-profile-gate.ts";

/**
 * The learner's deterministic pre-gate (memory audit P7): a table of synthetic messages. The
 * must-pass rows hold a fact about the owner (and the gate may not drop them); the must-skip
 * rows are chatter, code and questions that never cost a model call.
 */

const gate = (text: string, attached = false) =>
  learnGate(text, { work: looksLikeWork(text), ...(attached ? { attached: true } : {}) });

const MUST_PASS: [string, string][] = [
  ["name", "My name is Priya, but call me Pri"],
  ["name 2", "Please call me Dave from now on"],
  ["name 3", "I'm Marcus and I like short answers"],
  ["timezone", "I'm on Pacific time, so schedule things after 9am"],
  ["timezone 2", "It's 9am here in California right now, my timezone is America/Los_Angeles"],
  ["city", "I live in Lisbon with my sister"],
  ["city 2", "I moved to Austin last spring"],
  ["job", "I work at Acme as a data engineer"],
  ["job 2", "I'm a nurse at the county hospital"],
  ["study", "I study chemistry at UCSC"],
  ["diet", "I'm vegetarian and I don't eat eggs"],
  ["diet 2", "I don't like cilantro, remember that"],
  ["pref", "I prefer tea over coffee in the morning"],
  ["pref 2", "I always book aisle seats"],
  ["remember", "Remember that I am allergic to peanuts"],
  ["routine", "I usually run at 6am before work"],
  ["person", "My sister Maya teaches piano"],
  ["person 2", "My manager Dana is on leave until June"],
  ["project", "My thesis is about coral reefs"],
  ["future", "For future reference, send me summaries as bullets"],
  ["going forward", "Going forward keep replies under three lines please"],
  ["work hint due", "The lab report is due Friday and I'm stuck on part 2"],
  ["work hint submit", "I submitted the problem set last night"],
  ["work hint progress", "Working on the slides, finished the intro"],
  ["es", "Me llamo Lucía y vivo en Sevilla"],
  ["es 2", "Prefiero el té al café por la mañana"],
  ["fr", "Je suis végétarien et j'habite à Lyon"],
  ["fr 2", "Appelle-moi Jo, s'il te plaît"],
  ["de", "Ich wohne in Berlin und arbeite bei einer Bank"],
  ["de 2", "Meine Schwester heißt Anna"],
  ["it", "Abito a Torino e lavoro in un ospedale"],
  ["it 2", "Preferisco il caffè senza zucchero"],
  ["pt", "Eu moro em Lisboa e trabalho num banco"],
  ["pt 2", "Minha irmã se chama Ana"],
  ["ja", "私は東京に住んでいます"],
  ["zh", "我住在上海，在一家银行工作"],
  ["ko", "저는 서울에 살고 채식을 해요"],
  ["ar", "اسمي ليلى وأعيش في القاهرة"],
  ["hi", "मैं दिल्ली में रहता हूँ और शाकाहारी हूँ"],
  ["ru", "Меня зовут Олег, я живу в Казани"],
  ["code plus cue", "My name is Sam, here is the snippet:\n```\nconst a = 1;\n```"],
];

const MUST_SKIP: [string, string][] = [
  ["ok", "ok"],
  ["thanks", "thanks"],
  ["thanks long", "thanks so much, that helps"],
  ["short", "yes please"],
  ["weather", "what's the weather"],
  ["weather 2", "what is the weather like in Paris"],
  ["search", "find the latest news about electric cars"],
  ["translate", "translate good morning into Spanish"],
  ["math", "what is 17 times 23"],
  ["define", "define serendipity"],
  ["summarize", "summarize this article for me"],
  ["continue", "continue with the next step"],
  ["code fence only", "```ts\nconst x = 1;\nconsole.log(x);\n```"],
  [
    "code paste",
    "import fs from 'fs';\nconst data = fs.readFileSync('a.txt');\nfunction run() {\n  return data;\n}\nrun();",
  ],
  [
    "stack trace",
    "TypeError: x is not a function\n  at run (/app/a.js:10:5)\n  at main (/app/b.js:4:1)\n  at Object.<anonymous> (/app/c.js:1:1)",
  ],
  ["code with my_var", "const my_var = compute();\nlet other = my_var + 1;\nreturn other;"],
  ["question", "how do I center a div"],
  ["command", "open the calendar app please"],
  ["lorem", "lorem ipsum dolor sit amet consectetur adipiscing elit"],
  ["url", "https://example.com/docs/getting-started"],
  ["es chatter", "gracias, perfecto"],
  ["fr chatter", "merci beaucoup, très bien"],
  ["de chatter", "danke, das ist gut so"],
  ["pt chatter", "obrigado, está ótimo"],
  ["it chatter", "grazie mille, va bene"],
  ["empty", ""],
  ["spaces", "      "],
];

describe("learner pre-gate table", () => {
  it("has at least 50 rows", () => {
    expect(MUST_PASS.length + MUST_SKIP.length).toBeGreaterThanOrEqual(50);
  });

  it.each(MUST_PASS)("passes %s: %s", (_name, text) => {
    expect(gate(text)).toBe(true);
  });

  it.each(MUST_SKIP)("skips %s: %s", (_name, text) => {
    expect(gate(text)).toBe(false);
  });

  it("reports the hit rate: every fact row passes and no chatter row does", () => {
    const hits = (rows: [string, string][]) => rows.filter(([, t]) => gate(t)).length;
    expect(hits(MUST_PASS) / MUST_PASS.length).toBe(1);
    expect(hits(MUST_SKIP)).toBe(0);
    // Of all rows the gate lets through a bit under half the table: most chatter never pays.
    const rate = (hits(MUST_PASS) + hits(MUST_SKIP)) / (MUST_PASS.length + MUST_SKIP.length);
    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.7);
  });

  it("lets an attachment through, but never a message too short to hold a fact", () => {
    expect(gate("here is my cv for you to read", true)).toBe(true);
    expect(gate("ok", true)).toBe(false);
  });

  it("does not block non-Latin scripts outright (they pass to the model under the cap)", () => {
    expect(gate("今日の天気を教えてください")).toBe(true);
    expect(gate("¿qué hora es en Tokio ahora?")).toBe(false);
  });
});
