// Spike 01 — Electron main process.
//
// One BaseWindow: a sidebar WebContentsView plus agent tabs, each a WebContentsView in the
// persist:agent-spike partition with webContents.debugger attached. A Unix-socket server
// forwards raw CDP commands/events to an external process using NDJSON frames:
//
//   request   {"id":1,"tabId":"t1","method":"Page.navigate","params":{...},"sessionId"?:...}
//   response  {"id":1,"result":{...}}  |  {"id":1,"error":{"code":"...","message":"..."}}
//   event     {"tabId":"t1","method":"Page.loadEventFired","params":{...},"sessionId"?:...}
//
// Methods prefixed "Bridge." are handled here (tabs, take control, metrics, devtools tests);
// everything else is passed verbatim to webContents.debugger.sendCommand.

import { app, BaseWindow, WebContentsView, ipcMain, session } from 'electron';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARTITION = 'persist:agent-spike';
const SOCKET = process.env.CDP_BRIDGE_SOCKET || path.join(os.tmpdir(), `psyche-cdp-${process.pid}.sock`);
const USER_IDLE_MS = Number(process.env.CDP_BRIDGE_USER_IDLE_MS || 1500);
const AGENT_INPUT_GRACE_MS = 50; // only used to ignore gesture/wheel events trailing an agent wheel
const now = () => Date.now();
const SIDEBAR_W = 220;
const QUARANTINE = path.join(here, '.out', 'quarantine');
// Agent tabs are usually not on screen (pane closed, window occluded). Without this, Chromium marks
// them hidden: rAF stops, Page.startScreencast emits nothing and Input.dispatchMouseEvent(mouseMoved)
// blocks ~5 s waiting for a frame. CDP_BRIDGE_THROTTLE=1 restores the default to reproduce that.
const TAB_PREFS = { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: process.env.CDP_BRIDGE_THROTTLE === '1' };

app.setPath('userData', path.join(here, '.userdata'));
app.setName('psyche-cdp-spike');

/** @type {Map<string, Tab>} */
const tabs = new Map();
let nextTab = 1;
let activeTabId = null;
let win;
let sidebar;
const clients = new Set();
const downloads = [];
const log = (...a) => console.log('[main]', ...a);

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {WebContentsView} view
 * @property {Electron.WebContents} wc
 * @property {boolean} userHold     sticky "Take control" from the sidebar button
 * @property {number} userActiveUntil  ms timestamp; user is in control while now < this
 * @property {number} agentInputUntil  ms timestamp; input-event seen before this is ours
 * @property {number} agentInputDepth
 * @property {string|null} openerTabId
 * @property {{at:number, reason:string}[]} detaches
 * @property {{user:number, agentEcho:number, refused:number}} counters
 */

function contentBounds() {
  const [w, h] = win.getContentSize();
  return { x: SIDEBAR_W, y: 0, width: w - SIDEBAR_W, height: h };
}

function broadcast(frame) {
  const line = JSON.stringify(frame) + '\n';
  for (const c of clients) c.write(line);
}

function tabSummary(t) {
  return {
    tabId: t.id,
    url: t.wc.getURL(),
    title: t.wc.getTitle(),
    openerTabId: t.openerTabId,
    attached: t.wc.debugger.isAttached(),
    userInControl: userInControl(t),
    active: t.id === activeTabId,
  };
}

function pushSidebar() {
  if (!sidebar) return;
  sidebar.webContents.send('state', { tabs: [...tabs.values()].map(tabSummary), downloads });
}

function userInControl(t) {
  return t.userHold || Date.now() < t.userActiveUntil;
}

function setActive(tabId) {
  activeTabId = tabId;
  for (const t of tabs.values()) t.view.setVisible(t.id === tabId);
  pushSidebar();
}

function attachDebugger(t) {
  const dbg = t.wc.debugger;
  if (dbg.isAttached()) return;
  dbg.attach('1.3');
}

function createTab({ url, webContents, openerTabId = null } = {}) {
  const id = `t${nextTab++}`;
  const view = webContents
    ? new WebContentsView({ webContents })
    : new WebContentsView({ webPreferences: TAB_PREFS });
  const wc = view.webContents;
  /** @type {Tab} */
  const t = {
    id, view, wc, openerTabId,
    userHold: false, userActiveUntil: 0, agentInputUntil: 0, agentInputDepth: 0,
    detaches: [], counters: { user: 0, agentEcho: 0, refused: 0 }, inputLog: [],
  };
  tabs.set(id, t);
  win.contentView.addChildView(view);
  view.setBounds(contentBounds());

  attachDebugger(t);
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    broadcast({ tabId: id, method, params, ...(sessionId ? { sessionId } : {}) });
  });
  wc.debugger.on('detach', (_e, reason) => {
    t.detaches.push({ at: Date.now(), reason });
    log(`debugger detached from ${id}: ${reason}`);
    broadcast({ tabId: id, method: 'Bridge.detached', params: { reason } });
  });
  wc.on('devtools-closed', () => {
    // Re-attach once the user closes DevTools so the agent can carry on.
    try { attachDebugger(t); broadcast({ tabId: id, method: 'Bridge.reattached', params: {} }); }
    catch (err) { log('reattach failed', err.message); }
  });

  // Take control. Measured discriminators (Electron 44):
  //  - CDP Input.* events reach 'input-event' (as keyDown/mouseDown/...) but never 'before-input-event'.
  //  - Native keyboard input (OS events, sendInputEvent) fires 'before-input-event' plus
  //    'input-event' rawKeyDown/char, so keyboard needs no timing heuristics at all.
  //  - Mouse has no such split: a mouseDown/mouseWheel 'input-event' counts as the user only when no
  //    agent Input.* command is in flight (echoes arrive synchronously inside sendCommand), and
  //    wheel-derived gesture events trailing an agent wheel are ignored for a short grace period.
  const grab = (kind, type) => {
    const now = Date.now();
    const was = userInControl(t);
    t.counters.user++;
    t.userActiveUntil = now + USER_IDLE_MS;
    if (!was) {
      broadcast({ tabId: id, method: 'Bridge.userControl', params: { active: true, via: kind, type } });
      pushSidebar();
    }
    clearTimeout(t.releaseTimer);
    t.releaseTimer = setTimeout(function check() {
      if (userInControl(t)) { t.releaseTimer = setTimeout(check, t.userActiveUntil - Date.now() + 5); return; }
      broadcast({ tabId: id, method: 'Bridge.userControl', params: { active: false } });
      pushSidebar();
    }, USER_IDLE_MS + 5);
  };
  const record = (kind, type) => {
    const now = Date.now();
    if (t.inputLog.length < 5000) t.inputLog.push({ at: now, kind, type, agentDepth: t.agentInputDepth, inGrace: now < t.agentInputUntil });
  };
  wc.on('before-input-event', (_e, ev) => {
    record('before-input-event', ev.type);
    if (ev.type === 'keyDown') grab('keyboard', ev.type);
    else if (now() < t.userActiveUntil) t.userActiveUntil = now() + USER_IDLE_MS;
  });
  wc.on('input-event', (_e, ev) => {
    record('input-event', ev.type);
    const agent = t.agentInputDepth > 0;
    if (agent) { t.counters.agentEcho++; return; }
    if (ev.type === 'mouseDown' || (ev.type === 'mouseWheel' && Date.now() >= t.agentInputUntil)) grab('mouse', ev.type);
    else if ((ev.type === 'mouseMove' || ev.type === 'mouseUp') && Date.now() < t.userActiveUntil) t.userActiveUntil = Date.now() + USER_IDLE_MS;
  });

  wc.setWindowOpenHandler((details) => {
    log(`window.open from ${id}: ${details.url} (${details.disposition})`);
    return {
      action: 'allow',
      // Adopt the popup's WebContents into a new agent tab so window.opener survives (OAuth).
      createWindow: (options) => {
        const child = createTab({ webContents: options.webContents, openerTabId: id });
        setActive(child.id);
        broadcast({ tabId: id, method: 'Bridge.tabOpened', params: { child: child.id, url: details.url, disposition: details.disposition } });
        return child.wc;
      },
      overrideBrowserWindowOptions: { webPreferences: TAB_PREFS },
    };
  });
  wc.on('destroyed', () => {
    tabs.delete(id);
    broadcast({ tabId: id, method: 'Bridge.tabClosed', params: {} });
    if (activeTabId === id) setActive([...tabs.keys()][0] ?? null);
  });
  wc.on('did-navigate', pushSidebar);
  wc.on('page-title-updated', pushSidebar);

  if (url) wc.loadURL(url);
  if (!activeTabId) setActive(id);
  else view.setVisible(id === activeTabId);
  pushSidebar();
  return t;
}

function tabMemory(t) {
  // A tab can span several renderer processes (site isolation puts cross-site iframes in OOPIFs).
  const pids = new Set();
  try { for (const f of t.wc.mainFrame.framesInSubtree) pids.add(f.osProcessId); } catch {}
  pids.add(t.wc.getOSProcessId());
  const metrics = app.getAppMetrics();
  const procs = metrics.filter((m) => pids.has(m.pid)).map((m) => ({ pid: m.pid, type: m.type, workingSetKB: m.memory.workingSetSize, peakKB: m.memory.peakWorkingSetSize }));
  return { pids: [...pids], procs, workingSetKB: procs.reduce((s, p) => s + p.workingSetKB, 0) };
}

const INPUT_METHODS = /^Input\./;

async function handleBridge(t, method, params = {}) {
  switch (method) {
    case 'Bridge.listTabs': return { tabs: [...tabs.values()].map(tabSummary) };
    case 'Bridge.createTab': { const n = createTab({ url: params.url }); if (params.activate) setActive(n.id); return { tabId: n.id }; }
    case 'Bridge.activateTab': setActive(params.tabId); return {};
    case 'Bridge.closeTab': tabs.get(params.tabId)?.wc.close(); return {};
    case 'Bridge.session': {
      const ses = session.fromPartition(PARTITION);
      return { partition: PARTITION, storagePath: ses.storagePath, isPersistent: ses.isPersistent(), userData: app.getPath('userData') };
    }
    case 'Bridge.metrics': {
      const all = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name, workingSetKB: m.memory.workingSetSize }));
      return { tabs: Object.fromEntries([...tabs.values()].map((x) => [x.id, tabMemory(x)])), processes: all };
    }
    case 'Bridge.takeControl': t.userHold = true; broadcast({ tabId: t.id, method: 'Bridge.userControl', params: { active: true, via: 'button' } }); pushSidebar(); return {};
    case 'Bridge.releaseControl': t.userHold = false; t.userActiveUntil = 0; broadcast({ tabId: t.id, method: 'Bridge.userControl', params: { active: false } }); pushSidebar(); return {};
    case 'Bridge.inputLog': { const l = t.inputLog; if (params.clear) t.inputLog = []; return { log: l }; }
    case 'Bridge.controlState': return { userInControl: userInControl(t), counters: t.counters, detaches: t.detaches };
    case 'Bridge.openDevTools': t.wc.openDevTools({ mode: 'detach', activate: false }); return {};
    case 'Bridge.detachDebugger': t.wc.debugger.detach(); return {};
    case 'Bridge.attachDebugger': attachDebugger(t); return {};
    case 'Bridge.closeDevTools': t.wc.closeDevTools(); return {};
    case 'Bridge.isAttached': return { attached: t.wc.debugger.isAttached(), devToolsOpen: t.wc.isDevToolsOpened() };
    case 'Bridge.downloads': return { downloads };
    case 'Bridge.windowFocus': {
      if (params.focus === true) { if (params.steal) app.focus({ steal: true }); win.focus(); t.wc.focus(); }
      if (params.focus === false) win.blur();
      if (params.minimize) win.minimize();
      if (params.restore) win.restore();
      if (params.hideView === true) t.view.setVisible(false);
      if (params.hideView === false) t.view.setVisible(true);
      return { windowFocused: win.isFocused(), minimized: win.isMinimized(), wcFocused: t.wc.isFocused(), visible: t.view.getVisible() };
    }
    // Simulates a human: native-style input through webContents.sendInputEvent, which takes the
    // same RenderWidgetHost path as OS events (unlike CDP Input.*, which the bridge marks as agent).
    case 'Bridge.simulateUser': {
      if (params.click) {
        const { x, y } = params.click;
        t.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        t.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }
      for (const ch of params.text ?? '') {
        t.wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
        t.wc.sendInputEvent({ type: 'char', keyCode: ch });
        t.wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
        if (params.delayMs) await new Promise((r) => setTimeout(r, params.delayMs));
      }
      return {};
    }
    // In-process baseline: same command with no socket hop.
    case 'Bridge.benchInProcess': {
      const n = params.n ?? 200; const out = [];
      for (let i = 0; i < n; i++) {
        const s = process.hrtime.bigint();
        await t.wc.debugger.sendCommand(params.method ?? 'Runtime.evaluate', params.params ?? { expression: '1+1', returnByValue: true });
        out.push(Number(process.hrtime.bigint() - s) / 1e6);
      }
      return { samplesMs: out };
    }
    default: throw Object.assign(new Error(`unknown bridge method ${method}`), { code: 'UNKNOWN_METHOD' });
  }
}

async function handleFrame(sock, frame) {
  const { id, tabId, method, params, sessionId } = frame;
  const reply = (body) => sock.write(JSON.stringify({ id, ...body }) + '\n');
  try {
    const t = tabId ? tabs.get(tabId) : null;
    if (tabId && !t) throw Object.assign(new Error(`no tab ${tabId}`), { code: 'NO_TAB' });
    if (method.startsWith('Bridge.')) return reply({ result: await handleBridge(t, method, params) });
    if (!t) throw Object.assign(new Error('tabId required for CDP methods'), { code: 'NO_TAB' });
    if (!t.wc.debugger.isAttached()) throw Object.assign(new Error('debugger detached (DevTools open?)'), { code: 'DETACHED' });
    if (INPUT_METHODS.test(method)) {
      if (userInControl(t)) { t.counters.refused++; throw Object.assign(new Error('user is in control of this tab'), { code: 'USER_IN_CONTROL' }); }
      t.agentInputDepth++;
      try { return reply({ result: await t.wc.debugger.sendCommand(method, params ?? {}, sessionId) }); }
      finally { t.agentInputDepth--; t.agentInputUntil = Date.now() + AGENT_INPUT_GRACE_MS; }
    }
    reply({ result: await t.wc.debugger.sendCommand(method, params ?? {}, sessionId) });
  } catch (err) {
    reply({ error: { code: err.code ?? 'CDP_ERROR', message: err.message } });
  }
}

function startSocket() {
  try { fs.unlinkSync(SOCKET); } catch {}
  const server = net.createServer((sock) => {
    clients.add(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { sock.write(JSON.stringify({ error: { code: 'BAD_FRAME', message: 'invalid JSON' } }) + '\n'); continue; }
        handleFrame(sock, frame);
      }
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
  });
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    log(`bridge listening on ${SOCKET}`);
    // Machine-readable line for run.mjs.
    console.log(`BRIDGE_READY ${SOCKET}`);
  });
}

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  ses.on('will-download', (_e, item, wc) => {
    fs.mkdirSync(QUARANTINE, { recursive: true });
    const target = path.join(QUARANTINE, `${Date.now()}-${item.getFilename()}`);
    item.setSavePath(target);
    const rec = { url: item.getURL(), filename: item.getFilename(), mime: item.getMimeType(), savePath: target, state: 'progressing', bytes: 0, tabId: [...tabs.values()].find((x) => x.wc === wc)?.id ?? null };
    downloads.push(rec);
    item.on('done', (_ev, state) => {
      rec.state = state; rec.bytes = item.getReceivedBytes();
      broadcast({ tabId: rec.tabId, method: 'Bridge.downloadDone', params: rec });
      pushSidebar();
    });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  win = new BaseWindow({ width: 1280, height: 860, title: 'Psyche CDP bridge spike' });
  sidebar = new WebContentsView({ webPreferences: { preload: path.join(here, 'sidebar-preload.cjs'), sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(sidebar);
  const layout = () => {
    const [, h] = win.getContentSize();
    sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height: h });
    for (const t of tabs.values()) t.view.setBounds(contentBounds());
  };
  win.on('resize', layout);
  sidebar.webContents.loadFile(path.join(here, 'sidebar.html'));
  sidebar.webContents.on('did-finish-load', pushSidebar);
  layout();

  ipcMain.on('sidebar', (_e, msg) => {
    const t = tabs.get(msg.tabId);
    if (msg.op === 'activate') setActive(msg.tabId);
    if (msg.op === 'take' && t) handleBridge(t, 'Bridge.takeControl');
    if (msg.op === 'release' && t) handleBridge(t, 'Bridge.releaseControl');
  });

  createTab({ url: 'about:blank' });
  createTab({ url: 'about:blank' });
  startSocket();
  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { fs.unlinkSync(SOCKET); } catch {} });
