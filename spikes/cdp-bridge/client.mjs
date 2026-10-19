// Spike 01 — external agent-side process. Connects to the Electron bridge socket, runs every
// experiment and writes .out/results.json, .out/results.md, .out/snapshots/*, .out/frames/*.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from './bridge-client.mjs';
import { RefRegistry, takeSnapshot, findRef, clickRef, typeRef, centerOf } from './snapshot.mjs';
import { startFixtures } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '.out');
const socketPath = process.argv[2] || process.env.CDP_BRIDGE_SOCKET;
if (!socketPath) { console.error('usage: node client.mjs <socket>'); process.exit(2); }

const REAL_PAGES = [
  ['hn', 'https://news.ycombinator.com/'],
  ['wikipedia', 'https://en.wikipedia.org/wiki/Electron_(software_framework)'],
  ['bbc-news', 'https://www.bbc.com/news'],
  ['github', 'https://github.com/electron/electron'],
  ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/API/Window/open'],
];

const USER_IDLE_MS = 1500; // matches main.mjs default
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: r1(s[0]), p50: r1(q(0.5)), p90: r1(q(0.9)), p99: r1(q(0.99)), max: r1(s[s.length - 1]), mean: r1(s.reduce((a, b) => a + b, 0) / s.length) };
}

const results = { startedAt: new Date().toISOString(), experiments: {} };
const log = (...a) => console.log('[client]', ...a);
const bridge = await BridgeClient.connect(socketPath);
const fx = await startFixtures();
fs.mkdirSync(path.join(OUT, 'snapshots'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

const refsByTab = new Map();
const refsFor = (tabId) => { if (!refsByTab.has(tabId)) refsByTab.set(tabId, new RefRegistry()); return refsByTab.get(tabId); };
const enabled = new Set();
async function ensureDomains(tabId) {
  if (enabled.has(tabId)) return;
  await bridge.send(tabId, 'Page.enable');
  enabled.add(tabId);
}
async function navigate(tabId, url, timeoutMs = 25000) {
  await ensureDomains(tabId);
  const loaded = bridge.waitFor(tabId, 'Page.loadEventFired', undefined, timeoutMs).then(() => true, () => false);
  const s = performance.now();
  const nav = await bridge.send(tabId, 'Page.navigate', { url });
  if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
  const ok = await loaded;
  const ms = performance.now() - s;
  await bridge.send(tabId, 'DOM.getDocument', { depth: 0 });
  return { loadMs: r1(ms), loadEventFired: ok };
}
async function isolatedEval(tabId, expression) {
  const { frameTree } = await bridge.send(tabId, 'Page.getFrameTree');
  const { executionContextId } = await bridge.send(tabId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'psyche-agent' });
  const r = await bridge.send(tabId, 'Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function run(name, fn) {
  log(`== ${name}`);
  const s = performance.now();
  try { results.experiments[name] = { ok: true, ...(await fn()) }; }
  catch (err) { results.experiments[name] = { ok: false, error: String(err.stack || err) }; log(`!! ${name} failed: ${err.message}`); }
  results.experiments[name].wallMs = r1(performance.now() - s);
}

const { tabs } = await bridge.send(null, 'Bridge.listTabs');
const [T1, T2] = tabs.map((t) => t.tabId);

await run('session', async () => {
  const s = await bridge.send(null, 'Bridge.session');
  // Cookies from a previous run prove the persist: partition survives restarts (cookies ignore ports).
  const { cookies } = await bridge.send(T1, 'Network.getCookies', { urls: ['http://127.0.0.1/'] });
  let files = [];
  try { files = fs.readdirSync(s.storagePath); } catch {}
  return { ...s, storageFiles: files, cookiesFromPreviousRun: cookies.map((c) => `${c.name}=${c.value}`) };
});

await run('memoryBaseline', async () => bridge.send(null, 'Bridge.metrics'));

await run('roundTrip', async () => {
  await navigate(T1, 'about:blank');
  const evalP = { expression: '1+1', returnByValue: true };
  for (let i = 0; i < 20; i++) await bridge.send(T1, 'Runtime.evaluate', evalP); // warm-up
  const viaBridge = [];
  for (let i = 0; i < 500; i++) { const s = performance.now(); await bridge.send(T1, 'Runtime.evaluate', evalP); viaBridge.push(performance.now() - s); }
  const bridgeOnly = [];
  for (let i = 0; i < 500; i++) { const s = performance.now(); await bridge.send(T1, 'Bridge.listTabs'); bridgeOnly.push(performance.now() - s); }
  const { samplesMs: inProc } = await bridge.send(T1, 'Bridge.benchInProcess', { n: 500 });
  const mouse = [];
  for (let i = 0; i < 200; i++) { const s = performance.now(); await bridge.send(T1, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10 + (i % 50), y: 10 }); mouse.push(performance.now() - s); }
  await sleep(200);
  // Pipelined: 1000 commands in flight at once.
  const s = performance.now();
  await Promise.all(Array.from({ length: 1000 }, () => bridge.send(T1, 'Runtime.evaluate', evalP)));
  const pipelinedMs = performance.now() - s;
  return {
    runtimeEvaluateViaBridgeMs: stats(viaBridge),
    socketOnlyBridgeListTabsMs: stats(bridgeOnly),
    runtimeEvaluateInProcessMs: stats(inProc),
    inputDispatchMouseMovedViaBridgeMs: stats(mouse),
    pipelined1000: { totalMs: r1(pipelinedMs), perSecond: Math.round(1000 / (pipelinedMs / 1000)) },
  };
});

await run('snapshots', async () => {
  const pages = [...REAL_PAGES, ['login-fixture', `${fx.origin}/login`]];
  const rows = [];
  for (const [name, url] of pages) {
    const row = { name, url };
    try {
      Object.assign(row, await navigate(T1, url));
      await sleep(800); // let late layout settle
      const refs = refsFor(T1);
      const cold = await takeSnapshot(bridge, T1, refs);
      const warm = await takeSnapshot(bridge, T1, refs);
      const warm2 = await takeSnapshot(bridge, T1, refs);
      const refsStable = JSON.stringify(cold.entries.map((e) => e.ref)) === JSON.stringify(warm.entries.map((e) => e.ref));
      fs.writeFileSync(path.join(OUT, 'snapshots', `${name}.txt`), cold.text);
      const mem = await bridge.send(null, 'Bridge.metrics');
      Object.assign(row, {
        cold: cold.stats, warm: warm.stats, warm2: warm2.stats, refsStableAcrossSnapshots: refsStable,
        tabWorkingSetMB: r1(mem.tabs[T1].workingSetKB / 1024), tabProcesses: mem.tabs[T1].procs.length,
      });
      if (name === 'wikipedia') {
        const { samplesMs } = await bridge.send(T1, 'Bridge.benchInProcess', { n: 5, method: 'Accessibility.getFullAXTree', params: {} });
        const via = [];
        for (let i = 0; i < 5; i++) { const s = performance.now(); await bridge.send(T1, 'Accessibility.getFullAXTree', {}); via.push(performance.now() - s); }
        row.largePayload = { inProcessMs: stats(samplesMs), viaBridgeMs: stats(via), bytes: cold.stats.axBytes };
      }
    } catch (err) { row.error = err.message; }
    rows.push(row);
    log(name, row.error ?? `ax ${r1(row.cold.axMs)}ms total ${r1(row.cold.totalMs)}ms warm ${r1(row.warm.totalMs)}ms, ${row.cold.rawNodes}→${row.cold.keptNodes} nodes, ~${row.cold.approxTokens} tok`);
  }
  return { rows };
});

await run('loginByRef', async () => {
  await navigate(T1, `${fx.origin}/login`);
  const refs = refsFor(T1);
  const snap = await takeSnapshot(bridge, T1, refs);
  const user = findRef(snap, 'textbox', 'username');
  const pass = findRef(snap, 'textbox', 'password');
  const remember = findRef(snap, 'checkbox', 'remember');
  const submit = findRef(snap, 'button', 'sign in');
  const timings = {};
  let s = performance.now(); await clickRef(bridge, T1, refs, user); timings.clickMs = r1(performance.now() - s);
  s = performance.now(); await typeRef(bridge, T1, refs, user, 'ada'); timings.typeMs = r1(performance.now() - s);
  // Credential fields would be "you type" / vault fill in the product; the fixture uses a dummy value.
  await typeRef(bridge, T1, refs, pass, 'dummy-fixture-pw');
  await clickRef(bridge, T1, refs, remember);
  const after = await takeSnapshot(bridge, T1, refs);
  const sameRefs = [user, pass, remember, submit].every((r) => after.entries.some((e) => e.ref === r));
  s = performance.now(); await clickRef(bridge, T1, refs, submit); timings.submitClickMs = r1(performance.now() - s);
  await sleep(100);
  const out = await isolatedEval(T1, "document.getElementById('out').textContent");
  const isolatedSeesSecret = await isolatedEval(T1, 'typeof window.pageSecret');
  const mainSees = (await bridge.send(T1, 'Runtime.evaluate', { expression: 'typeof window.pageSecret', returnByValue: true })).result.value;
  const isolatedSeesDom = await isolatedEval(T1, "document.querySelector('input[name=user]').value");
  return { refs: { user, pass, remember, submit }, refsStableAfterTyping: sameRefs, timings, resultText: out, isolatedWorld: { seesPageGlobal: isolatedSeesSecret, mainWorldSeesPageGlobal: mainSees, seesDomValue: isolatedSeesDom }, snapshotAfterTyping: after.text };
});

await run('screencast', async () => {
  await navigate(T1, `${fx.origin}/anim`);
  const frames = [];
  const s = performance.now();
  const onEv = (f) => {
    if (f.tabId !== T1 || f.method !== 'Page.screencastFrame') return;
    frames.push({ at: performance.now() - s, bytes: Math.round(f.params.data.length * 3 / 4), meta: f.params.metadata, data: f.params.data });
    bridge.send(T1, 'Page.screencastFrameAck', { sessionId: f.params.sessionId }).catch(() => {});
  };
  bridge.on('event', onEv);
  await bridge.send(T1, 'Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  const deadline = Date.now() + 10000;
  while (frames.length < 10 && Date.now() < deadline) await sleep(20);
  await bridge.send(T1, 'Page.stopScreencast');
  bridge.off('event', onEv);
  frames.slice(0, 10).forEach((f, i) => fs.writeFileSync(path.join(OUT, 'frames', `frame-${String(i + 1).padStart(2, '0')}.jpg`), Buffer.from(f.data, 'base64')));
  const got = frames.slice(0, 10);
  const intervals = got.slice(1).map((f, i) => f.at - got[i].at);

  // Same thing with the view hidden (an agent tab that is not on screen).
  await bridge.send(T1, 'Bridge.windowFocus', { hideView: true });
  let hiddenFrames = 0;
  const onHidden = (f) => { if (f.tabId === T1 && f.method === 'Page.screencastFrame') { hiddenFrames++; bridge.send(T1, 'Page.screencastFrameAck', { sessionId: f.params.sessionId }).catch(() => {}); } };
  bridge.on('event', onHidden);
  await bridge.send(T1, 'Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800 });
  await sleep(2000);
  await bridge.send(T1, 'Page.stopScreencast');
  bridge.off('event', onHidden);
  const hiddenRaf = await isolatedEval(T1, "document.getElementById('n').textContent");
  await bridge.send(T1, 'Bridge.windowFocus', { hideView: false });
  return {
    frames: got.length, firstFrameMs: r1(got[0]?.at ?? NaN), intervalMs: intervals.length ? stats(intervals) : null,
    frameKB: stats(got.map((f) => f.bytes / 1024)), deviceSize: got[0] ? `${got[0].meta.deviceWidth}x${got[0].meta.deviceHeight}` : null,
    hiddenViewFramesIn2s: hiddenFrames, hiddenViewRafCounter: hiddenRaf,
  };
});

await run('takeControl', async () => {
  await navigate(T1, `${fx.origin}/pad`);
  await bridge.send(T1, 'Bridge.windowFocus', { focus: true, steal: true });
  await sleep(300);
  const refs = refsFor(T1);
  const snap = await takeSnapshot(bridge, T1, refs);
  const field = findRef(snap, 'textbox', 'notes');
  const button = findRef(snap, 'button', 'clicked');
  await bridge.send(T1, 'DOM.focus', { backendNodeId: refs.backend(field) });
  const control = [];
  const onCtl = (f) => { if (f.tabId === T1 && f.method === 'Bridge.userControl') control.push({ at: performance.now(), ...f.params }); };
  bridge.on('event', onCtl);

  // Phase A — agent alone: must not trip take control (false positives).
  for (let i = 0; i < 30; i++) { await bridge.send(T1, 'Input.insertText', { text: 'a' }); await sleep(10); }
  for (let i = 0; i < 5; i++) await clickRef(bridge, T1, refs, button);
  for (const ch of 'key') {
    await bridge.send(T1, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
    await bridge.send(T1, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  await sleep(300);
  const falsePositives = control.length;
  const st0 = await bridge.send(T1, 'Bridge.controlState');

  // Phase B — agent types continuously; a "human" types mid-way through sendInputEvent.
  await bridge.send(T1, 'DOM.focus', { backendNodeId: refs.backend(field) });
  const attempts = [];
  let userStart, userEnd;
  const t0 = performance.now();
  const human = (async () => {
    await sleep(500);
    userStart = performance.now();
    await bridge.send(T1, 'Bridge.simulateUser', { text: 'HUMAN', delayMs: 80 });
    userEnd = performance.now();
  })();
  while (performance.now() - t0 < 4500) {
    const at = performance.now();
    try { await bridge.send(T1, 'Input.insertText', { text: 'x' }); attempts.push({ at, ok: true }); }
    catch (err) { attempts.push({ at, ok: false, code: err.code }); }
    await sleep(25);
  }
  await human;
  const refused = attempts.filter((a) => !a.ok);
  const firstRefused = refused[0];
  const lastRefused = refused[refused.length - 1];
  const firstOkAfter = attempts.find((a) => a.ok && lastRefused && a.at > lastRefused.at);
  const acceptedDuringUser = attempts.filter((a) => a.ok && a.at > (firstRefused?.at ?? Infinity) && a.at < (lastRefused?.at ?? 0)).length;
  const valueB = await isolatedEval(T1, "document.getElementById('t').value");
  const trusted = (await bridge.send(T1, 'Runtime.evaluate', { expression: "JSON.stringify(keyLog.filter(e => e.type === 'keydown').map(e => [e.key, e.trusted]))", returnByValue: true })).result.value;

  // Phase B2 — same, but the human clicks (mouse) instead of typing.
  await sleep(USER_IDLE_MS + 300);
  const fieldAt = await centerOf(bridge, T1, refs, field);
  const attempts2 = [];
  let clickAt;
  const t2 = performance.now();
  const human2 = (async () => { await sleep(500); clickAt = performance.now(); await bridge.send(T1, 'Bridge.simulateUser', { click: { x: Math.round(fieldAt.x), y: Math.round(fieldAt.y) } }); })();
  while (performance.now() - t2 < 3000) {
    const at = performance.now();
    try { await bridge.send(T1, 'Input.insertText', { text: 'm' }); attempts2.push({ at, ok: true }); }
    catch (err) { attempts2.push({ at, ok: false, code: err.code }); }
    await sleep(25);
  }
  await human2;
  const ref2 = attempts2.filter((a) => !a.ok);
  const okAfter2 = attempts2.find((a) => a.ok && ref2.length && a.at > ref2[ref2.length - 1].at);
  const phaseB2 = {
    attempts: attempts2.length, refused: ref2.length,
    firstRefusalAfterClickMs: ref2[0] ? r1(ref2[0].at - clickAt) : null,
    resumeAfterClickMs: okAfter2 ? r1(okAfter2.at - clickAt) : null,
  };

  // Phase C — explicit Take control button (sticky until Release).
  await bridge.send(T1, 'Bridge.takeControl');
  let heldRefused = false;
  try { await bridge.send(T1, 'Input.insertText', { text: 'y' }); } catch (err) { heldRefused = err.code === 'USER_IN_CONTROL'; }
  await sleep(2000);
  let stillRefused = false;
  try { await bridge.send(T1, 'Input.insertText', { text: 'y' }); } catch (err) { stillRefused = err.code === 'USER_IN_CONTROL'; }
  await bridge.send(T1, 'Bridge.releaseControl');
  let resumed = false;
  try { await bridge.send(T1, 'Input.insertText', { text: 'z' }); resumed = true; } catch {}
  bridge.off('event', onCtl);
  const st1 = await bridge.send(T1, 'Bridge.controlState');
  return {
    phaseA: { falsePositiveControlEvents: falsePositives, echoesFiltered: st0.counters.agentEcho },
    phaseB: {
      attempts: attempts.length, refused: refused.length, acceptedWhileUserActive: acceptedDuringUser,
      userTypingMs: r1(userEnd - userStart),
      firstRefusalAfterUserStartMs: firstRefused ? r1(firstRefused.at - userStart) : null,
      resumeAfterUserEndMs: firstOkAfter ? r1(firstOkAfter.at - userEnd) : null,
      controlEvents: control.map((c) => ({ atMs: r1(c.at - t0), active: c.active, via: c.via, type: c.type })),
      fieldValue: valueB, keydownTrusted: trusted,
    },
    phaseB2,
    phaseC: { buttonHoldRefused: heldRefused, stillRefusedAfter2s: stillRefused, resumedAfterRelease: resumed },
    counters: st1.counters,
  };
});

await run('focus', async () => {
  await navigate(T1, `${fx.origin}/pad`);
  const refs = refsFor(T1);
  const snap = await takeSnapshot(bridge, T1, refs);
  const field = findRef(snap, 'textbox', 'notes');
  const button = findRef(snap, 'button', 'clicked');
  const read = async () => ({
    value: await isolatedEval(T1, "document.getElementById('t').value"),
    clicks: Number(await isolatedEval(T1, "document.getElementById('c').dataset.n || 0")),
    hasFocus: await isolatedEval(T1, 'document.hasFocus()'),
    visibility: await isolatedEval(T1, 'document.visibilityState'),
  });
  const states = [
    ['focused', { focus: true, steal: true }, {}],
    ['blurred', { focus: false }, {}],
    ['minimized', { minimize: true }, { restore: true }],
    ['viewHidden', { hideView: true }, { hideView: false }],
  ];
  const rows = [];
  for (const [name, enter, exit] of states) {
    await bridge.send(T1, 'Bridge.releaseControl');
    await bridge.send(T1, 'Runtime.evaluate', { expression: "document.getElementById('t').value=''" });
    const win = await bridge.send(T1, 'Bridge.windowFocus', enter);
    await sleep(600);
    const before = await read();
    let cdpClick = 'ok', cdpType = 'ok';
    try {
      const { x, y } = await centerOf(bridge, T1, refs, button);
      await bridge.send(T1, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await bridge.send(T1, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } catch (err) { cdpClick = err.message; }
    try { await typeRef(bridge, T1, refs, field, 'cdp'); } catch (err) { cdpType = err.message; }
    await sleep(150);
    const mid = await read();
    await bridge.send(T1, 'Bridge.simulateUser', { text: 'si' });
    await sleep(300);
    const after = await read();
    rows.push({
      state: name, window: win, before: { hasFocus: before.hasFocus, visibility: before.visibility },
      cdpClickRegistered: mid.clicks > before.clicks, cdpInsertTextRegistered: mid.value.includes('cdp'), cdpErrors: [cdpClick, cdpType].filter((e) => e !== 'ok'),
      sendInputEventRegistered: after.value.includes('si'), finalValue: after.value,
    });
    await bridge.send(T1, 'Bridge.windowFocus', exit);
    await sleep(400);
  }
  await bridge.send(T1, 'Bridge.releaseControl');
  await bridge.send(T1, 'Bridge.windowFocus', { focus: true });
  return { rows };
});

await run('popupOAuth', async () => {
  await navigate(T1, `${fx.origin}/oauth`);
  const refs = refsFor(T1);
  const snap = await takeSnapshot(bridge, T1, refs);
  const btn = findRef(snap, 'button', 'sign in with provider');
  const opened = bridge.waitFor(T1, 'Bridge.tabOpened', undefined, 10000);
  await clickRef(bridge, T1, refs, btn);
  const { params: { child, url, disposition } } = await opened;
  await ensureDomains(child);
  let childUrl = '';
  for (let i = 0; i < 100; i++) {
    const r = await bridge.send(child, 'Runtime.evaluate', { expression: 'location.href + " " + document.readyState', returnByValue: true });
    childUrl = r.result.value;
    if (childUrl.includes('/oauth/authorize') && childUrl.endsWith('complete')) break;
    await sleep(50);
  }
  await bridge.send(child, 'DOM.getDocument', { depth: 0 });
  const cRefs = refsFor(child);
  const cSnap = await takeSnapshot(bridge, child, cRefs);
  const openerInPopup = await isolatedEval(child, "document.getElementById('opener').textContent");
  const { tabs: list } = await bridge.send(null, 'Bridge.listTabs');
  const approve = findRef(cSnap, 'button', 'approve');
  const closed = bridge.waitFor(child, 'Bridge.tabClosed', undefined, 5000).then(() => true, () => false);
  await clickRef(bridge, child, cRefs, approve);
  const childClosed = await closed;
  await sleep(200);
  const tok = await isolatedEval(T1, "document.getElementById('tok').textContent");
  const authReq = fx.seen.find((x) => x.path === '/oauth/authorize');
  return {
    childTab: child, url, disposition, childUrl, openerTabId: list.find((t) => t.tabId === child)?.openerTabId,
    openerVisibleInPopup: openerInPopup, childSnapshot: cSnap.text,
    popupClosedItself: childClosed, openerReceived: tok, popupRequestCookies: authReq?.cookie ?? null,
  };
});

await run('downloads', async () => {
  await navigate(T1, `${fx.origin}/downloads`);
  const refs = refsFor(T1);
  const snap = await takeSnapshot(bridge, T1, refs);
  const done = bridge.waitFor(null, 'Bridge.downloadDone', undefined, 10000);
  await clickRef(bridge, T1, refs, findRef(snap, 'link', 'attachment'));
  const d = (await done).params;
  const onDisk = fs.existsSync(d.savePath) ? fs.statSync(d.savePath).size : null;
  // Inline PDF: does the built-in viewer render it or does it become a download?
  const inlineDone = bridge.waitFor(null, 'Bridge.downloadDone', undefined, 6000).then((f) => f.params, () => null);
  await clickRef(bridge, T1, refs, findRef(snap, 'link', 'inline'));
  const inline = await inlineDone;
  await sleep(1500);
  const { tabs: list } = await bridge.send(null, 'Bridge.listTabs');
  const inlineDoc = inline ? null : (await bridge.send(T1, 'Runtime.evaluate', { expression: "JSON.stringify({ type: document.contentType, embeds: document.querySelectorAll('embed,iframe').length })", returnByValue: true })).result.value;
  if (!inline) { const shot = await bridge.send(T1, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, 'inline-pdf.png'), Buffer.from(shot.data, 'base64')); }
  return { inlineDoc, attachment: { ...d, bytesOnDisk: onDisk, headerStartsPdf: onDisk ? fs.readFileSync(d.savePath).subarray(0, 5).toString() : null }, inlinePdf: inline ? { becameDownload: true, ...inline } : { becameDownload: false, tabUrl: list.find((t) => t.tabId === T1)?.url } };
});

await run('memoryTwoTabs', async () => {
  await Promise.all([navigate(T1, REAL_PAGES[1][1]), navigate(T2, REAL_PAGES[0][1])]);
  await sleep(1000);
  const m = await bridge.send(null, 'Bridge.metrics');
  const byType = {};
  for (const p of m.processes) byType[p.type] = r1((byType[p.type] ?? 0) + p.workingSetKB / 1024);
  return { tabs: Object.fromEntries(Object.entries(m.tabs).map(([k, v]) => [k, { workingSetMB: r1(v.workingSetKB / 1024), procs: v.procs.length }])), totalByProcessTypeMB: byType };
});

await run('devtoolsDetach', async () => {
  await navigate(T1, `${fx.origin}/login`);
  const detached = bridge.waitFor(T1, 'Bridge.detached', undefined, 5000).then((f) => f.params, () => null);
  await bridge.send(T1, 'Bridge.openDevTools');
  const det = await detached;
  const state = await bridge.send(T1, 'Bridge.isAttached');
  let whileOpen;
  try { whileOpen = (await bridge.send(T1, 'Runtime.evaluate', { expression: '20+1', returnByValue: true })).result.value; } catch (err) { whileOpen = err.code; }
  // Explicit detach (what the docs describe DevTools doing): domains and events are lost on re-attach.
  const reattached = bridge.waitFor(T1, 'Bridge.reattached', undefined, 8000).then(() => true, () => false);
  await bridge.send(T1, 'Bridge.closeDevTools');
  const re = await reattached;
  const ok = (await bridge.send(T1, 'Runtime.evaluate', { expression: '40+2', returnByValue: true })).result.value;
  const evAfter = bridge.waitFor(T1, 'Page.loadEventFired', undefined, 4000).then(() => true, () => false);
  await bridge.send(T1, 'Page.navigate', { url: `${fx.origin}/pad` });
  const pageEventsAfterReattach = await evAfter;
  return { detachEvent: det, stateWhileDevToolsOpen: state, commandWhileDevToolsOpen: whileOpen, reattachedOnClose: re, evalAfterClose: ok, pageEventsAfterReattach };
});

await run('forcedDetach', async () => {
  // Simulate the detach the docs describe (DevTools in older builds, renderer crash, other client).
  const detached = bridge.waitFor(T1, 'Bridge.detached', undefined, 3000).then((f) => f.params, () => null);
  await bridge.send(T1, 'Bridge.detachDebugger');
  const det = await detached;
  let during;
  try { await bridge.send(T1, 'Runtime.evaluate', { expression: '1' }); during = 'ok'; } catch (err) { during = err.code; }
  await bridge.send(T1, 'Bridge.attachDebugger');
  const evNoEnable = bridge.waitFor(T1, 'Page.loadEventFired', undefined, 4000).then(() => true, () => false);
  await bridge.send(T1, 'Page.navigate', { url: `${fx.origin}/login` });
  const pageEventsWithoutReenable = await evNoEnable;
  enabled.delete(T1);
  return { detachEvent: det, commandWhileDetached: during, pageEventsWithoutReenable };
});

results.finishedAt = new Date().toISOString();
results.bridgeBytesIn = bridge.bytesIn;
const resultsFile = path.join(OUT, `results${process.env.CDP_BRIDGE_THROTTLE === '1' ? '-throttled' : ''}.json`);
results.backgroundThrottling = process.env.CDP_BRIDGE_THROTTLE === '1';
fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
log(`wrote ${resultsFile}`);
fx.close();
bridge.close();
const failed = Object.entries(results.experiments).filter(([, v]) => !v.ok).map(([k]) => k);
if (failed.length) log('FAILED:', failed.join(', '));
process.exit(0);
