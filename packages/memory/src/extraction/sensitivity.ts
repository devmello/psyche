import type { GraphSensitivity } from "@psyche/protocol";
import { detectSensitive } from "../filters.ts";

/**
 * The deterministic sensitivity classifier (docs/design/everything-memory-2026.md §10.2). It runs
 * next to the model's own label and the STRICTER of the two wins; unclear means sensitive. Class
 * order below is also the severity order: a hard-blocked class beats an owner-switchable one.
 *
 * Keyword lists are deliberately broad and multilingual: a false positive costs one dropped
 * fact, a false negative stores something the owner switched off.
 */

/** Strictest first. */
export const SENSITIVITY_ORDER: readonly GraphSensitivity[] = [
  "gov_id",
  "account_numbers",
  "health",
  "sexuality",
  "legal",
  "ethnicity",
  "religion",
  "politics",
  "finance",
  "precise_location",
  "none",
];

const severity = (c: GraphSensitivity) => SENSITIVITY_ORDER.indexOf(c);

/** The stricter of two classes. */
export function stricterSensitivity(a: GraphSensitivity, b: GraphSensitivity): GraphSensitivity {
  return severity(a) <= severity(b) ? a : b;
}

const KEYWORDS: Partial<Record<GraphSensitivity, RegExp>> = {
  health:
    /\b(?:diagnos\w*|prescri\w*|medic(?:ation|ine|ación|amento|ament)\w*|allerg\w*|alergi\w*|asthma\w*|cancer|cáncer|krebs|chemo\w*|diabet\w*|insulin\w*|depress\w*|anxiety|anxiété|angst\w*|bipolar|adhd|autis\w*|pregnan\w*|embaraz\w*|enceinte|schwanger\w*|gravid\w*|miscarriage|disabilit\w*|discapacidad|handicap\w*|therap\w*|terapia|psychiat\w*|psiquiatr\w*|hiv|vih|surgery|chirurg\w*|cirug\w*|illness|sick|enfermedad|maladie|krankheit|celiac|epilep\w*|dementia|stroke|infarct\w*|medical|clinic|hospital\w*|rehab\w*|sobriety|addict\w*)\b|疾病|癌|怀孕|過敏|过敏|抑郁/iu,
  sexuality:
    /\b(?:gay|lesbian|bisexual|bi-sexual|pansexual|asexual|queer|transgender|trans woman|trans man|homosexual|heterosexual|sexual orientation|coming out|came out|sex life|sexual|homosexuel\w*|homosexual\w*|bisexuel\w*|orientación sexual|sexuelle orientierung)\b|同性恋|同志/iu,
  religion:
    /\b(?:muslim|islam\w*|christian\w*|catholic\w*|protestant|jewish|judaism|hindu\w*|buddhis\w*|sikh\w*|atheis\w*|agnostic\w*|church|mosque|synagogue|temple|prayer|pray\w*|faith|religio\w*|religión|religion|kosher|halal|ramadan|baptis\w*|bar mitzvah|bat mitzvah|pastor|imam|rabbi|priest|sacrament\w*|glaube\w*|croyan\w*)\b|基督|伊斯兰|佛教/iu,
  politics:
    /\b(?:democrat\w*|republican\w*|conservative\w*|liberal\w*|socialis\w*|communis\w*|fascis\w*|libertarian|trump|biden|political\w*|party member|union member|trade union|voted|voting|vote for|election\w*|partido|parti politique|politisch\w*|sindicato|syndicat|gewerkschaft|left-wing|right-wing|activist\w*|protest\w*)\b/iu,
  ethnicity:
    /\b(?:ethnic\w*|race|racial|immigra\w*|immigrant|visa status|green card|citizenship|citizen of|asylum|refugee|undocumented|deport\w*|nationality|etnia|origine ethnique|herkunft|asylant|inmigra\w*)\b/iu,
  legal:
    /\b(?:arrest\w*|convict\w*|criminal|felony|misdemeanor|lawsuit|sued|court|trial|prison|jail|probation|parole|custody|divorce|restraining order|indict\w*|attorney|lawyer|abogado|avocat|anwalt|demanda|procès|klage|sentence[d]?|bail)\b/iu,
  finance:
    /\b(?:salary|salaries|income|earns?|earning|paid|payroll|debt|owes?|owed|loan|mortgage|credit score|bankrupt\w*|net worth|savings|invest\w*|stock options?|equity|bonus|rent is|tax return|tax refund|sueldo|salario|deuda|salaire|dette|gehalt|schulden|\$\s?\d[\d,.]*\s?(?:k|m|million|thousand)?|€\s?\d[\d,.]*|£\s?\d[\d,.]*)/iu,
  precise_location:
    /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,40}\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|calle|rue|straße|strasse|via)\b|\b(?:apt|apartment|unit|suite|flat)\s*#?\s*\d+\w*|\b-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b|\b(?:every (?:mon|tues|wednes|thurs|fri|satur|sun)day (?:at|morning|evening)|gym schedule|commute|leaves home|comes home|home address|lives at|zip code)\b/iu,
};

/** Classes the plain-language attribute itself implies. */
const ATTRIBUTE_CLASS: Partial<Record<string, GraphSensitivity>> = {
  diet: "none",
};

/**
 * Classify `text` (the fact value plus its quote). Returns the strictest class found, `none`
 * when nothing matched. Structured patterns (ids, accounts) come from the shared secret filters.
 */
export function classifySensitivity(text: string, attribute?: string): GraphSensitivity {
  let best: GraphSensitivity =
    attribute === undefined ? "none" : (ATTRIBUTE_CLASS[attribute] ?? "none");
  const found = detectSensitive(text);
  if (found.includes("government_id")) best = stricterSensitivity(best, "gov_id");
  if (found.some((k) => k === "financial_account" || k === "card" || k === "secret")) {
    best = stricterSensitivity(best, "account_numbers");
  }
  if (found.includes("health")) best = stricterSensitivity(best, "health");
  for (const [cls, re] of Object.entries(KEYWORDS) as [GraphSensitivity, RegExp][]) {
    if (re.test(text)) best = stricterSensitivity(best, cls);
  }
  return best;
}
