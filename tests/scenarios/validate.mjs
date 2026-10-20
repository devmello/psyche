#!/usr/bin/env node
// Validates every tests/scenarios/*/scenario.json against schema.json plus the cross-file rules in
// README.md ("What validate.mjs checks"), then prints a summary. Dependency-free on purpose: it
// runs before the monorepo scaffold exists. The scenario runner in packages/testing reuses the
// same rules once it lands.
//
//   node tests/scenarios/validate.mjs [--json]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRegistry } from "../fixtures/secrets/derive.mjs";

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const schema = JSON.parse(readFileSync(join(here, "schema.json"), "utf8"));
const registry = resolveRegistry(
  JSON.parse(readFileSync(join(root, "tests/fixtures/secrets/registry.json"), "utf8")),
);
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
// `--dir <path>`: validate the scenarios in another folder (INT-3's Milestone 2 scenarios live in
// tests/acceptance/scenarios-m2); the schema and the secret registry stay this folder's.
const dirArg = argv.indexOf("--dir");
const scanRoot = dirArg >= 0 && argv[dirArg + 1] ? resolve(argv[dirArg + 1]) : here;

const MAX_PAGE_BYTES = 4096;

// ---- minimal JSON Schema interpreter (the subset schema.json uses) ----

function resolveRef(ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => node[key], schema);
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deref(node) {
  return node.$ref ? deref(resolveRef(node.$ref)) : node;
}

// For oneOf over tagged objects (assertions by `type`, steps by `kind`) pick the alternative by
// its const tag so error messages point at the right shape.
function discriminate(alts, value) {
  if (typeOf(value) !== "object") return undefined;
  for (const tag of ["type", "kind"]) {
    const tagged = alts.map(deref).filter((a) => a.properties?.[tag]?.const !== undefined);
    if (tagged.length === alts.length) {
      return { tag, alt: tagged.find((a) => a.properties[tag].const === value[tag]) };
    }
  }
  return undefined;
}

function check(node, value, path, errors) {
  if (node.$ref) return check(resolveRef(node.$ref), value, path, errors);
  if (node.oneOf) {
    const d = discriminate(node.oneOf, value);
    if (d) {
      if (!d.alt) errors.push(`${path}: unknown ${d.tag} ${JSON.stringify(value[d.tag])}`);
      else check(d.alt, value, path, errors);
      return;
    }
    const passing = node.oneOf.filter((alt) => {
      const e = [];
      check(alt, value, path, e);
      return e.length === 0;
    });
    if (passing.length !== 1) {
      errors.push(`${path}: must match exactly one alternative (matched ${passing.length})`);
    }
    if (passing.length === 0) {
      const alts = node.oneOf.map(deref);
      const alt =
        alts.find((a) => (a.required ?? []).every((k) => value && k in value)) ??
        alts.find((a) => a.type === typeOf(value)) ??
        alts[alts.length - 1];
      check(alt, value, path, errors);
    }
    return;
  }
  if ("const" in node && value !== node.const) {
    errors.push(`${path}: must be ${JSON.stringify(node.const)}`);
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (node.type) {
    const t = typeOf(value);
    const ok = node.type === "integer" ? Number.isInteger(value) : t === node.type;
    if (!ok) {
      errors.push(`${path}: expected ${node.type}, got ${t}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(`${path}: shorter than ${node.minLength}`);
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      errors.push(`${path}: longer than ${node.maxLength}`);
    }
    if (node.pattern && !new RegExp(node.pattern, "u").test(value)) {
      errors.push(`${path}: does not match ${node.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path}: fewer than ${node.minItems} items`);
    }
    if (node.items) {
      value.forEach((v, i) => {
        check(node.items, v, `${path}[${i}]`, errors);
      });
    }
  }
  if (typeOf(value) === "object") {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing ${key}`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (node.propertyNames) check(node.propertyNames, key, `${path}.<key ${key}>`, errors);
      const sub = node.properties?.[key];
      if (sub) check(sub, v, `${path}.${key}`, errors);
      else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property ${key}`);
      } else if (typeof node.additionalProperties === "object") {
        check(node.additionalProperties, v, `${path}.${key}`, errors);
      }
    }
  }
}

// ---- helpers ----

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walk(value, visit, path = "") {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walk(v, visit, `${path}[${i}]`);
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${path}.${k}`);
      walk(v, visit, `${path}.${k}`);
    }
  }
}

function filesUnder(dir) {
  const outFiles = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) outFiles.push(...filesUnder(p));
    else outFiles.push(p);
  }
  return outFiles;
}

// Offset in minutes of a time zone at an instant (Intl "longOffset", e.g. GMT-07:00).
function tzOffsetMinutes(tz, ms) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName").value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function isoOffsetMinutes(iso) {
  if (iso.endsWith("Z")) return 0;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function localParts(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday.slice(0, 2).toUpperCase(),
  };
}

const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

// ---- secrets and CI secret-grep patterns ----

const secretIds = new Set([
  ...registry.vaultItems.map((i) => i.id),
  ...registry.standalone.map((s) => s.id),
]);
const secretValues = [
  ...registry.vaultItems.flatMap((i) =>
    Object.entries(i.fields)
      .filter(([k]) => k !== "username")
      .map(([, v]) => ({ id: i.id, value: v })),
  ),
  ...registry.standalone.map((s) => ({ id: s.id, value: s.value })),
].filter((s) => s.value.length >= 8);

// Built from parts so this file never matches the repository's own secret-grep gate.
const B = "-----BEGIN";
const ciPatterns = [
  ["pem private key", new RegExp(`${B} [A-Z ]*PRIVATE KEY-----`)],
  ["url with credentials", /https?:\/\/[^\s/:@"']+:[^\s/@"']+@/],
  ["sk- token", new RegExp(`\\b${"sk"}-(ant-)?[A-Za-z0-9]{20,}`)],
  ["github token", new RegExp(`\\b${"gh"}[pousr]_[A-Za-z0-9]{36}`)],
  ["github pat", new RegExp(`${"github"}_pat_[A-Za-z0-9_]{40}`)],
  ["aws key", new RegExp(`${"AK"}IA[0-9A-Z]{16}`)],
  ["google api key", new RegExp(`${"AI"}za[0-9A-Za-z_-]{35}`)],
  ["slack token", new RegExp(`${"xox"}[bp]-[A-Za-z0-9-]{10,}`)],
  ["telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
];

// ---- fixtures ----

function loadFixtures(sc, dir, errors, P) {
  const fx = {
    messageIds: new Set(),
    threadIds: new Set(),
    attachmentIds: new Set(),
    eventIds: new Set(),
    siteIds: new Set(),
    siteUrls: new Map(),
  };
  const at = (k) => join(dir, sc.fixtures[k]);
  for (const [k, rel] of Object.entries(sc.fixtures)) {
    if (!existsSync(join(dir, rel))) errors.push(`${P}: fixture ${k} missing: ${rel}`);
  }
  const clockMs = Date.parse(sc.setup.clockStart ?? sc.ownerDoc.clock.start);

  if (sc.fixtures.mailbox && existsSync(at("mailbox"))) {
    const mb = readJson(at("mailbox"));
    fx.mailbox = mb;
    const mbDir = dirname(at("mailbox"));
    for (const m of mb.messages) {
      if (fx.messageIds.has(m.id)) errors.push(`${P}: duplicate message id ${m.id}`);
      fx.messageIds.add(m.id);
      if (Date.parse(m.internalDate) > clockMs) {
        errors.push(`${P}: message ${m.id} is dated after the scenario clock start`);
      }
      for (const a of m.attachments) {
        fx.attachmentIds.add(a.id);
        const p = join(mbDir, a.path);
        if (!existsSync(p)) {
          errors.push(`${P}: attachment ${a.id} file missing: ${a.path}`);
          continue;
        }
        const buf = readFileSync(p);
        if (buf.length !== a.size) {
          errors.push(`${P}: attachment ${a.id} size ${buf.length} != ${a.size}`);
        }
        if (sha256(buf) !== a.sha256) errors.push(`${P}: attachment ${a.id} sha256 mismatch`);
      }
    }
    for (const t of mb.threads) {
      fx.threadIds.add(t.id);
      for (const id of t.messageIds) {
        const m = mb.messages.find((x) => x.id === id);
        if (!m || m.threadId !== t.id) {
          errors.push(`${P}: thread ${t.id} lists ${id} inconsistently`);
        }
      }
    }
    for (const m of mb.messages) {
      if (!fx.threadIds.has(m.threadId)) errors.push(`${P}: message ${m.id} has unknown thread`);
    }
    if (mb.secretRef && !secretIds.has(mb.secretRef)) {
      errors.push(`${P}: mailbox secretRef ${mb.secretRef} not in registry`);
    }
  }

  if (sc.fixtures.calendar && existsSync(at("calendar"))) {
    const cal = readJson(at("calendar"));
    fx.calendar = cal;
    for (const e of cal.events) {
      if (fx.eventIds.has(e.id)) errors.push(`${P}: duplicate event id ${e.id}`);
      fx.eventIds.add(e.id);
      for (const edge of ["start", "end"]) {
        const t = e[edge];
        if (!t.dateTime) continue;
        const ms = Date.parse(t.dateTime);
        const want = tzOffsetMinutes(t.timeZone ?? cal.timeZone, ms);
        if (Number.isNaN(ms) || isoOffsetMinutes(t.dateTime) !== want) {
          errors.push(`${P}: event ${e.id} ${edge} ${t.dateTime} offset wrong for ${t.timeZone}`);
        }
      }
      const s = e.start.dateTime ?? e.start.date;
      const en = e.end.dateTime ?? e.end.date;
      if (Date.parse(en) <= Date.parse(s)) errors.push(`${P}: event ${e.id} ends before it starts`);
    }
    for (const e of cal.events) {
      if (e.recurringEventId && !fx.eventIds.has(e.recurringEventId)) {
        errors.push(`${P}: instance ${e.id} has unknown master ${e.recurringEventId}`);
      }
    }
    if (cal.secretRef && !secretIds.has(cal.secretRef)) {
      errors.push(`${P}: calendar secretRef ${cal.secretRef} not in registry`);
    }
  }
  if (sc.fixtures.preferences && existsSync(at("preferences"))) {
    fx.preferences = readJson(at("preferences"));
  }

  if (sc.fixtures.sites && existsSync(at("sites"))) {
    const man = readJson(at("sites"));
    fx.sites = man;
    const manDir = dirname(at("sites"));
    for (const pg of man.pages) {
      if (fx.siteIds.has(pg.id)) errors.push(`${P}: duplicate site id ${pg.id}`);
      fx.siteIds.add(pg.id);
      fx.siteUrls.set(pg.url, pg);
      const host = new URL(pg.url).hostname;
      if (!/(\.example|\.test|example\.(com|org|net))$/.test(host)) {
        errors.push(`${P}: site ${pg.id} host ${host} is not a reserved fictional domain`);
      }
      if (pg.status === 200) {
        const p = pg.file ? join(manDir, pg.file) : "";
        if (!pg.file || !existsSync(p)) errors.push(`${P}: site ${pg.id} page file missing`);
        else if (statSync(p).size >= MAX_PAGE_BYTES) {
          const size = statSync(p).size;
          errors.push(`${P}: site ${pg.id} page is ${size} bytes (limit ${MAX_PAGE_BYTES})`);
        }
      } else if (pg.status >= 300 && pg.status < 400) {
        if (!pg.location) errors.push(`${P}: redirect ${pg.id} needs location`);
        if (pg.file) errors.push(`${P}: redirect ${pg.id} must not have a file`);
      } else if (pg.file) errors.push(`${P}: ${pg.status} page ${pg.id} must not have a file`);
    }
  }

  if (sc.fixtures.searchResults && existsSync(at("searchResults"))) {
    const sr = readJson(at("searchResults"));
    fx.searchResults = sr;
    if (!secretIds.has(sr.auth?.secretRef)) {
      errors.push(`${P}: search auth secretRef not in registry`);
    }
    if (sr.auth?.placeholder !== `{{cred:${sr.auth?.secretRef}}}`) {
      errors.push(`${P}: search auth placeholder must be {{cred:<secretRef>}}`);
    }
    for (const r of [...sr.queries.flatMap((q) => q.results), ...sr.fallback]) {
      const pg = fx.siteUrls.get(r.url);
      if (!pg) errors.push(`${P}: search result ${r.url} not in sites manifest`);
      else if (pg.id !== r.siteId) errors.push(`${P}: search result ${r.url} siteId mismatch`);
    }
  }
  return fx;
}

// ---- slot correctness (proposed_slots.expectScripted) ----

function localMidnight(date, tz) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  return Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutes(tz, noon) * 60000;
}

function busyIntervals(cal, overrides) {
  const owner = "owner@example.com";
  const res = [];
  for (const e0 of cal.events) {
    if (e0.kind === "recurring_master") continue;
    const e = overrides.get(e0.id) ? { ...e0, ...overrides.get(e0.id) } : e0;
    if (e.status === "cancelled" || e.transparency === "transparent") continue;
    const me = (e.attendees ?? []).find((a) => a.email === owner);
    if (me?.responseStatus === "declined") continue;
    if (e.start.date) {
      const s = localMidnight(e.start.date, cal.timeZone);
      res.push({ id: e.id, s, e: localMidnight(e.end.date, cal.timeZone) });
    } else res.push({ id: e.id, s: Date.parse(e.start.dateTime), e: Date.parse(e.end.dateTime) });
  }
  return res;
}

function checkSlots(a, fx, overrides, P, errors) {
  if (!fx.calendar || !fx.preferences) {
    errors.push(`${P}: proposed_slots needs calendar and preferences fixtures`);
    return;
  }
  const prefs = fx.preferences;
  const busy = busyIntervals(fx.calendar, overrides);
  for (const slot of a.expectScripted ?? []) {
    const s = Date.parse(slot.start);
    const e = Date.parse(slot.end);
    const tag = `${P}: scripted slot ${slot.start}`;
    if ((e - s) / 60000 < a.durationMinutes) {
      errors.push(`${tag} shorter than ${a.durationMinutes} min`);
    }
    const ls = localParts(s, prefs.timezone);
    const le = localParts(e - 1, prefs.timezone);
    if (!a.days.includes(ls.date)) errors.push(`${tag} not on an allowed day`);
    const wh = prefs.workingHours[ls.weekday];
    if (!wh || ls.minutes < hhmm(wh[0]) || le.minutes + 1 > hhmm(wh[1])) {
      errors.push(`${tag} outside working hours`);
    }
    if (ls.minutes < hhmm(prefs.noMeetingsBefore)) errors.push(`${tag} before noMeetingsBefore`);
    const lunch = prefs.lunch;
    if (lunch?.protected && ls.minutes < hhmm(lunch.end) && le.minutes + 1 > hhmm(lunch.start)) {
      errors.push(`${tag} overlaps lunch`);
    }
    for (const b of busy) if (s < b.e && b.s < e) errors.push(`${tag} overlaps busy event ${b.id}`);
  }
  if ((a.expectScripted ?? []).length < a.min) {
    errors.push(`${P}: expectScripted has fewer than min slots`);
  }
}

// ---- cross-file rules for one scenario ----

const REF_KEYS = {
  messageId: "messageIds",
  messageIds: "messageIds",
  threadId: "threadIds",
  attachmentId: "attachmentIds",
  eventId: "eventIds",
  eventIds: "eventIds",
  siteId: "siteIds",
  siteIds: "siteIds",
  forbiddenCitationSiteIds: "siteIds",
};

function crossCheck(sc, dir, errors) {
  const P = relative(root, join(dir, "scenario.json"));
  if (sc.id !== dir.split("/").pop()) {
    errors.push(`${P}: id ${sc.id} must equal its directory name`);
  }
  for (const k of ["owner", "tools"]) {
    if (!existsSync(join(dir, sc[k]))) errors.push(`${P}: ${k} file missing: ${sc[k]}`);
  }
  sc.ownerDoc = readJson(join(dir, sc.owner));
  const toolsDoc = readJson(join(dir, sc.tools));
  const tools = new Map(toolsDoc.tools.map((t) => [t.name, t]));
  const fx = loadFixtures(sc, dir, errors, P);

  for (const c of sc.ownerDoc.connectors) {
    // Connectors without a credential (the V3 shopping allowlist) have no secretRef.
    if (c.secretRef !== undefined && !secretIds.has(c.secretRef))
      errors.push(`${P}: owner connector ${c.id} secretRef unknown`);
  }
  const connectorIds = new Set(sc.ownerDoc.connectors.map((c) => c.id));
  for (const c of sc.setup.connectors) {
    if (!connectorIds.has(c)) errors.push(`${P}: setup connector ${c} not in owner.json`);
  }
  for (const r of sc.secretRefs) if (!secretIds.has(r)) errors.push(`${P}: unknown secretRef ${r}`);

  // ids
  const stepIds = new Set();
  const callIds = new Map(); // id -> step index
  const approvalIds = new Map(); // approval_requested id -> {step index, modes}
  const assertionIds = new Set();
  const captures = new Map(); // name -> step index
  let modelEvents = 0;
  const calendarOverrides = new Map();

  const allAssertions = [];
  const noteAssertion = (a, where, stepIdx, stepModes) => {
    allAssertions.push({ a, where, stepIdx, stepModes });
    if (a.id) {
      if (assertionIds.has(a.id)) errors.push(`${where}: duplicate assertion id ${a.id}`);
      assertionIds.add(a.id);
    }
  };

  sc.steps.forEach((st, i) => {
    const W = `${P}#${st.id}`;
    if (stepIds.has(st.id)) errors.push(`${W}: duplicate step id`);
    stepIds.add(st.id);
    const stepModes = st.modes ?? ["scripted", "live"];
    if (st.kind === "owner_message" && stepModes.includes("scripted") && !st.script) {
      errors.push(`${W}: owner_message steps need a script for scripted mode`);
    }
    if (st.kind === "advance_clock" && !st.by === !st.to) {
      errors.push(`${W}: give exactly one of by|to`);
    }
    for (const turn of st.script?.turns ?? []) {
      if (turn.text) modelEvents += 1;
      for (const c of turn.toolCalls ?? []) {
        modelEvents += 1;
        if (callIds.has(c.id)) errors.push(`${W}: duplicate call id ${c.id}`);
        callIds.set(c.id, i);
        const t = tools.get(c.tool);
        if (!t) {
          errors.push(`${W}: ${c.id} uses unknown tool ${c.tool}`);
          continue;
        }
        if (t.sideEffect !== c.sideEffect) {
          errors.push(`${W}: ${c.id} sideEffect != registry (${t.sideEffect})`);
        }
        if (t.targetKind !== c.targetKind) {
          errors.push(`${W}: ${c.id} targetKind != registry (${t.targetKind})`);
        }
        if ((c.targetKind === null) !== (c.target === null)) {
          errors.push(`${W}: ${c.id} target must be null exactly when targetKind is null`);
        }
        // `approvalKinds`: a tool whose card kind depends on the operation (V10's code.git).
        if (c.expect?.decision === "ask" && !t.approvalKind && !t.approvalKinds?.length) {
          errors.push(`${W}: ${c.id} expects ask but ${c.tool} has no approvalKind`);
        }
        if (c.tool === "calendar.update" && c.args.eventId && c.args.event) {
          calendarOverrides.set(c.args.eventId, c.args.event);
        }
      }
    }
    for (const a of st.assertions ?? []) {
      noteAssertion(a, W, i, stepModes);
      if (a.type === "approval_requested") approvalIds.set(a.id, { i, modes: stepModes });
      if (a.type === "proposed_slots") {
        if (a.capture) captures.set(a.capture, i);
        if (a.expectScripted) checkSlots(a, fx, calendarOverrides, W, errors);
      }
    }
  });
  const end = sc.steps.length;
  for (const a of sc.finalAssertions) noteAssertion(a, `${P}#final`, end, ["scripted", "live"]);
  for (const kp of sc.resumability.killPoints) {
    for (const a of kp.expect.assertions) noteAssertion(a, `${P}#${kp.id}`, end, ["scripted"]);
  }
  for (const a of sc.resumability.invariants) {
    noteAssertion(a, `${P}#invariants`, end, ["scripted"]);
  }

  const approvalBefore = (ref, idx, where, sameStepOk) => {
    const hit = approvalIds.get(ref);
    if (!hit) errors.push(`${where}: approvalRef ${ref} is not an approval_requested id`);
    else if (hit.i > idx || (!sameStepOk && hit.i === idx)) {
      errors.push(`${where}: approvalRef ${ref} must come from an earlier step`);
    }
    return hit;
  };

  // approve steps and faults
  sc.steps.forEach((st, i) => {
    const W = `${P}#${st.id}`;
    const stepModes = st.modes ?? ["scripted", "live"];
    if (st.kind === "approve") {
      const hit = approvalBefore(st.approvalRef, i, W, false);
      if (hit && stepModes.some((m) => !hit.modes.includes(m))) {
        errors.push(`${W}: runs in a mode where ${st.approvalRef} is never requested`);
      }
      if (st.decision === "allow" && !st.scope) errors.push(`${W}: allow needs a scope`);
      if (st.token === "stale" && !st.expectAnswer?.startsWith("rejected")) {
        errors.push(`${W}: a stale token must expect a rejected answer`);
      }
    }
    if (st.kind === "fault" && !callIds.has(st.fault.callRef)) {
      errors.push(`${W}: fault callRef ${st.fault.callRef} unknown`);
    } else if (st.kind === "fault" && callIds.get(st.fault.callRef) > i) {
      errors.push(`${W}: fault must come after the call it tampers with is emitted`);
    }
  });

  // assertion semantics
  for (const { a, where, stepIdx } of allAssertions) {
    const W = `${where}/${a.type}`;
    if (a.tool && !tools.has(a.tool)) errors.push(`${W}: unknown tool ${a.tool}`);
    if (a.type === "tool_not_called" && !a.tool && !a.sideEffects) {
      errors.push(`${W}: needs tool or sideEffects`);
    }
    if (a.callRef && !callIds.has(a.callRef)) errors.push(`${W}: callRef ${a.callRef} unknown`);
    if (a.approvalRef) approvalBefore(a.approvalRef, stepIdx, W, true);
    for (const k of ["reissueOf", "sameBindingAs", "bindingDiffersFrom"]) {
      if (a[k]) approvalBefore(a[k], stepIdx, W, false);
    }
    if (a.type === "approval_requested" && a.sideEffect === "destructive" && a.scopesOffered) {
      if (a.scopesOffered.some((s) => s !== "once" && s !== "task")) {
        errors.push(`${W}: destructive approvals offer only once|task`);
      }
    }
    if (a.type === "approval_requested" && a.callRef && a.tool) {
      const owner = sc.steps[callIds.get(a.callRef)];
      const call = owner?.script.turns
        .flatMap((t) => t.toolCalls ?? [])
        .find((c) => c.id === a.callRef);
      if (call && call.tool !== a.tool) errors.push(`${W}: callRef tool ${call.tool} != ${a.tool}`);
      const t = tools.get(a.tool);
      if (t && !(t.approvalKinds ?? [t.approvalKind]).includes(a.approvalKind)) {
        errors.push(
          `${W}: ${a.tool} asks with ${t.approvalKinds ?? t.approvalKind}, not ${a.approvalKind}`,
        );
      }
    }
    if (a.type === "task_state" && !stepIds.has(a.taskOf)) {
      errors.push(`${W}: taskOf ${a.taskOf} unknown`);
    }
    if (a.type === "library_contains" && a.sha256Of && !existsSync(join(dir, a.sha256Of))) {
      errors.push(`${W}: sha256Of file missing: ${a.sha256Of}`);
    }
    if (a.type === "artifact" && a.citationsFrom && !fx.sites) {
      errors.push(`${W}: citationsFrom needs a sites fixture`);
    }
    if (a.type === "proposed_slots" && a.expectScripted && a.expectScripted.length < a.min) {
      errors.push(`${W}: expectScripted shorter than min`);
    }
    if (a.type === "no_secret_leak") {
      for (const r of a.secretRefs) {
        if (!secretIds.has(r)) {
          errors.push(`${W}: unknown secretRef ${r}`);
        }
      }
    }
    for (const k of ["min", "max", "equals", "count"]) {
      if (a[k] !== undefined && a[k] < 0) errors.push(`${W}: ${k} must be >= 0`);
    }
  }

  // fixture references anywhere in steps, scripts and assertions
  const scanned = {
    steps: sc.steps,
    finalAssertions: sc.finalAssertions,
    resumability: sc.resumability,
  };
  walk(scanned, (k, v, path) => {
    const set = REF_KEYS[k];
    if (!set) return;
    const values = typeof v === "string" ? [v] : Array.isArray(v) ? v : v?.equals ? [v.equals] : [];
    for (const id of values) {
      if (!fx[set].has(id)) errors.push(`${P}${path}: ${k} ${id} not found in fixtures`);
    }
  });

  // capture references: ${name...} must name a capture from an earlier step
  const strings = (v) =>
    typeof v === "string"
      ? [v]
      : v && typeof v === "object"
        ? Object.values(v).flatMap(strings)
        : [];
  sc.steps.forEach((st, i) => {
    for (const s of strings(st)) {
      for (const m of s.matchAll(/\$\{([A-Za-z_]\w*)/g)) {
        const at = captures.get(m[1]);
        if (at === undefined || at >= i) {
          errors.push(`${P}#${st.id}: capture ${m[1]} is not defined by an earlier step`);
        }
      }
    }
  });

  // kill points
  for (const kp of sc.resumability.killPoints) {
    const [kind, ref] = kp.at.split(":");
    const W = `${P}#${kp.id}`;
    if (kind === "after_model_event") {
      const n = Number(ref);
      if (n < 1 || n > modelEvents) errors.push(`${W}: model event ${n} outside 1..${modelEvents}`);
    } else if (kind === "while_awaiting_approval") {
      if (!approvalIds.has(ref)) errors.push(`${W}: ${ref} is not an approval_requested id`);
    } else if (!callIds.has(ref)) errors.push(`${W}: call ${ref} unknown`);
  }

  return { fx, modelEvents, assertions: allAssertions };
}

// ---- run ----

const errors = [];
const dirs = readdirSync(scanRoot)
  .filter((d) => existsSync(join(scanRoot, d, "scenario.json")))
  .sort();
const summary = [];
const byType = {};
for (const d of dirs) {
  const dir = join(scanRoot, d);
  const p = join(dir, "scenario.json");
  let sc;
  try {
    sc = readJson(p);
  } catch (e) {
    errors.push(`${d}/scenario.json: invalid JSON: ${e.message}`);
    continue;
  }
  const before = errors.length;
  check(schema, sc, `${d}/scenario.json`, errors);
  if (errors.length > before) continue; // cross-checks assume a schema-valid document
  try {
    const { fx, modelEvents, assertions } = crossCheck(sc, dir, errors);
    const count = (pred) => assertions.filter(({ a }) => pred(a)).length;
    for (const { a } of assertions) byType[a.type] = (byType[a.type] ?? 0) + 1;
    summary.push({
      id: sc.id,
      featureIds: sc.featureIds.join(" "),
      steps: sc.steps.length,
      modelEvents,
      assertions: assertions.length,
      hard: count((a) => a.severity === "hard"),
      soft: count((a) => a.severity === "soft"),
      softInLive: count((a) => (a.liveSeverity ?? a.severity) === "soft"),
      killPoints: sc.resumability.killPoints.length,
      fixtures: {
        messages: fx.messageIds.size,
        events: fx.eventIds.size,
        sites: fx.siteIds.size,
      },
    });
  } catch (e) {
    errors.push(`${d}/scenario.json: ${e.stack}`);
  }
}

// Secret values and CI secret-grep patterns must not appear in any scenario file.
for (const f of filesUnder(scanRoot)) {
  if (f === fileURLToPath(import.meta.url)) continue;
  const text = readFileSync(f, "latin1");
  const rel = relative(root, f);
  for (const s of secretValues) {
    if (text.includes(s.value)) errors.push(`${rel}: contains the value of secret ${s.id}`);
  }
  for (const [name, re] of ciPatterns) {
    if (re.test(text)) errors.push(`${rel}: matches CI secret-grep pattern (${name})`);
  }
}

if (dirs.length === 0) errors.push("no scenarios found");

if (asJson) {
  const result = { ok: errors.length === 0, errors, scenarios: summary, assertionsByType: byType };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const s of summary) {
    const steps = String(s.steps).padStart(2);
    const events = String(s.modelEvents).padStart(2);
    const kps = s.killPoints;
    out(`${s.id.padEnd(24)} steps ${steps}  model events ${events}  kill points ${kps}`);
    out(
      `  assertions ${s.assertions} (hard ${s.hard}, soft ${s.soft}, soft in live ${s.softInLive})`,
    );
    out(`  features: ${s.featureIds}`);
    const f = s.fixtures;
    out(`  fixtures: ${f.messages} messages, ${f.events} events, ${f.sites} sites`);
  }
  out("assertions by type:");
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    out(`  ${k.padEnd(28)} ${v}`);
  }
  if (errors.length) {
    err(`\n${errors.length} error(s):`);
    for (const e of errors) err(`  - ${e}`);
  } else out("\nok");
}
process.exit(errors.length ? 1 : 0);
