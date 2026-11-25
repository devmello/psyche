import fs from "node:fs";
// Regenerates PointsRuleTables.swift and points-tables.json from packages/protocol/src (run from the repo root):
//   node apps/mac-helper/scripts/gen-points-tables.mjs "$PWD" apps/mac-helper/Sources/PsycheHelperCore/Points/PointsRuleTables.swift
// The TS test points-tables.test.ts and the Swift test PointsRuleTablesFreshnessTests compare both to the sources,
// so a rule changed in points-rules.ts without regenerating fails verify.
const root = process.argv[2];
const src = fs.readFileSync(root + "/packages/protocol/src/points-rules.ts", "utf8");
const wm = src.match(/export const POINTS_SENSITIVE_WORDS[^=]*=\s*(\[[\s\S]*?\n\]);/)[1];
const WORDS = (0, eval)("(" + wm + ")");
const NPC = ["library", "loyalty", "membership", "student", "sim", "boarding", "business"];
const BENIGN = [
  `(?:${NPC.join("|")})[- ]?card(?:[- ]?(?:number|no|num))?`,
  "\\bpass[- ]?(?:through|note|notes|fare|type|rate|count|date|holder|ticket|class|mark)\\b",
];
const pr = { POINTS_SENSITIVE_WORDS: WORDS, POINTS_BENIGN_PHRASES: BENIGN };
const fb = fs.readFileSync(root + "/packages/protocol/src/financial-block.ts", "utf8");
const esc = (s) => {
  let o = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') o += '\\"';
    else if (ch === "\\") o += "\\\\";
    else if (cp < 0x20 || cp > 0x7e) o += `\\u{${cp.toString(16)}}`;
    else o += ch;
  }
  return o + '"';
};
let out = `// GENERATED from packages/protocol/src/points-rules.ts (POINTS_SENSITIVE_WORDS, POINTS_BENIGN_PHRASES,
// the confusables table) and financial-block.ts (HOST_VENUES), 2026-11-24. The probe table
// \`points-sensitive.json\` is the contract: PointsJudgeFixtureTests runs every row, so a drift shows
// as a failing row, not as a silent miss. Regex sources are JavaScript syntax with the \`u\` and \`i\`
// flags; NSRegularExpression (ICU) reads them the same way for these patterns.
enum PointsRuleTables {
    static let words: [(reason: String, source: String)] = [
`;
for (const w of pr.POINTS_SENSITIVE_WORDS) out += `        (${esc(w.reason)}, ${esc(w.source)}),\n`;
out += `    ]\n\n    static let benign: [String] = [\n`;
for (const b of pr.POINTS_BENIGN_PHRASES) out += `        ${esc(b)},\n`;
out += `    ]\n\n`;
const conf = {};
const blocks = [];
const m1 = src.match(/const CONFUSABLES[^=]*=\s*\{([\s\S]*?)\n\};/);
if (m1) blocks.push(m1[1]);
for (const m of src.matchAll(/Object\.assign\(CONFUSABLES, \{([\s\S]*?)\n\}\);/g)) blocks.push(m[1]);
for (const body of blocks) {
  for (const l of body.matchAll(/^\s*([^\s:/][^:]*?):\s*"([^"]*)",?\s*$/gm)) conf[l[1].trim()] = l[2];
}
out += `    static let confusables: [String: String] = [\n`;
for (const [k, v] of Object.entries(conf)) out += `        ${esc(k)}: ${esc(v)},\n`;
out += `    ]\n\n`;
const hv = fb.match(/const HOST_VENUES[^=]*=\s*\{([\s\S]*?)\n\};/)[1];
const hosts = [...hv.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
out += `    /// Registered domains of brokerages, exchanges and the like (\`venueOfHost\`): a host matches the domain or a subdomain.\n    static let venueDomains: [String] = [\n`;
for (const h of hosts) out += `        ${esc(h)},\n`;
out += `    ]\n}\n`;
fs.writeFileSync(process.argv[3], out);
console.log(Object.keys(conf).length, hosts.length, pr.POINTS_SENSITIVE_WORDS.length);

fs.writeFileSync(
  root + "/packages/protocol/test/fixtures/points-tables.json",
  JSON.stringify({ words: WORDS.map((w) => ({ reason: w.reason, source: w.source })), benign: BENIGN, confusables: conf, venueDomains: hosts }, null, 2) + "\n",
);
