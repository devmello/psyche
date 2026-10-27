// Trivial in-guest "node agent" for spike-06. Listens on loopback only; vsock-bridge forwards
// virtio-vsock port 7000 here. One JSON request per line, one JSON reply per line.
'use strict';
const net = require('node:net');
const os = require('node:os');
const { execFile } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.AGENT_PORT || 7001);
const started = Date.now();

function handle(req, reply) {
  switch (req.op) {
    case 'ping':
      return reply({ ok: true, pong: true, host: os.hostname(), user: os.userInfo().username,
                     os: os.release(), node: process.version, agentUptimeMs: Date.now() - started });
    case 'echo':
      return reply({ ok: true, echo: req.msg });
    case 'tcc':
      return execFile(path.join(__dirname, 'axcheck'), (err, out) =>
        reply(err ? { ok: false, error: String(err) } : { ok: true, tcc: JSON.parse(out) }));
    case 'shot':
      return execFile(path.join(__dirname, 'axcheck'), [req.path], (err, out) =>
        reply(err ? { ok: false, error: String(err) } : { ok: true, tcc: JSON.parse(out) }));
    case 'shutdown':
      // VZVirtualMachine.requestStop() is ignored by a logged-in macOS guest (no dialog, no
      // shutdown), so the host asks the agent instead. «aevtrsdn» = "really shut down".
      return execFile('/usr/bin/osascript', ['-e', 'tell application "loginwindow" to «event aevtrsdn»'],
        (err, out, errOut) => reply({ ok: !err, err: String(errOut) }));
    case 'ls':
      return execFile('/bin/ls', ['-la', req.path || '/Volumes'], (err, out, errOut) =>
        reply({ ok: !err, out: String(out), err: String(errOut) }));
    case 'write':
      return require('node:fs').writeFile(req.path, req.data || 'x', (err) =>
        reply({ ok: !err, error: err ? err.code : undefined }));
    default:
      return reply({ ok: false, error: 'unknown op' });
  }
}

net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let req;
      try { req = JSON.parse(line); } catch { req = { op: 'echo', msg: line }; }
      handle(req, (r) => sock.write(JSON.stringify(r) + '\n'));
    }
  });
  sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.error(`agent listening on 127.0.0.1:${PORT}`));
