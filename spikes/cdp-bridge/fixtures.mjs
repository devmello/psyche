// Local fixture pages: login form, OAuth-style popup, downloads, a typing pad, an animation.
import http from "node:http";

const page = (
  title,
  body,
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px} input,button{font:inherit;margin:4px 0;padding:6px} label{display:block;margin-top:10px}</style>
</head><body>${body}</body></html>`;

// Smallest valid one-page PDF (hand-written; xref offsets computed below).
function tinyPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 70 Td (Psyche spike PDF) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function startFixtures() {
  const seen = [];
  const pdf = tinyPdf();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ path: u.pathname, cookie: req.headers.cookie ?? null });
    const html = (s, extra = {}) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...extra });
      res.end(s);
    };
    switch (u.pathname) {
      case "/login":
        return html(
          page(
            "Sign in — fixture",
            `
<h1>Sign in</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Welcome ' + this.user.value + ' (password ' + this.pass.value.length + ' chars, remember=' + this.remember.checked + ')';">
  <label>Username <input name="user" autocomplete="username"></label>
  <label>Password <input name="pass" type="password" autocomplete="current-password"></label>
  <label><input name="remember" type="checkbox"> Remember me</label>
  <button type="submit">Sign in</button>
</form>
<p id="out" role="status"></p>
<p><a href="/forgot">Forgot password?</a></p>
<script>window.pageSecret = 'main-world-only';</script>`,
          ),
          { "set-cookie": `spike_login=${Date.now()}; Max-Age=86400; Path=/; HttpOnly` },
        );
      case "/oauth":
        return html(
          page(
            "App — fixture",
            `
<h1>Example app</h1>
<button id="b" onclick="window.open('/oauth/authorize?client_id=spike&state=xyz', 'oauth', 'width=480,height=600')">Sign in with Provider</button>
<p id="tok" role="status">not signed in</p>
<script>addEventListener('message', (e) => { if (e.data && e.data.token) document.getElementById('tok').textContent = 'token ' + e.data.token + ' from ' + e.origin; });</script>`,
          ),
          { "set-cookie": "spike_app=1; Path=/" },
        );
      case "/oauth/authorize":
        return html(
          page(
            "Authorize — fixture",
            `
<h1>Provider</h1><p>Allow <b>Example app</b> to read your profile?</p>
<p id="opener">opener: <script>document.write(window.opener ? 'present' : 'missing')</script></p>
<button onclick="window.opener && window.opener.postMessage({ token: 'tok_123' }, '*'); window.close();">Approve</button>`,
          ),
        );
      case "/downloads":
        return html(
          page(
            "Downloads — fixture",
            `<h1>Files</h1><p><a href="/file.pdf">Download PDF (attachment)</a></p><p><a href="/inline.pdf">Open PDF (inline)</a></p>`,
          ),
        );
      case "/file.pdf":
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="report.pdf"',
          "content-length": pdf.length,
        });
        return res.end(pdf);
      case "/inline.pdf":
        res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
        return res.end(pdf);
      case "/pad":
        return html(
          page(
            "Typing pad — fixture",
            `
<h1>Typing pad</h1>
<label>Notes <input id="t" style="width:600px" autofocus></label>
<button id="c" onclick="this.dataset.n = (+this.dataset.n || 0) + 1; this.textContent = 'Clicked ' + this.dataset.n;">Clicked 0</button>
<p id="focus"></p>
<script>
  window.keyLog = [];
  for (const ev of ['keydown', 'beforeinput', 'mousedown']) addEventListener(ev, (e) => keyLog.push({ type: e.type, trusted: e.isTrusted, key: e.key, data: e.data, t: performance.now() }), true);
</script>`,
          ),
        );
      case "/anim":
        return html(
          page(
            "Animation — fixture",
            `
<h1>Screencast source</h1><div id="box" style="width:120px;height:120px;background:#4a6cf7;border-radius:12px"></div><p id="n">0</p>
<script>let n = 0; (function f(){ n++; box.style.transform = 'translateX(' + (n * 4 % 600) + 'px)'; document.getElementById('n').textContent = n; requestAnimationFrame(f); })();</script>`,
          ),
        );
      default:
        res.writeHead(404);
        return res.end("not found");
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    }),
  );
}
