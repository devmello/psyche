// A stand-in for whisper.cpp's `whisper-server` (the flags Psyche passes, the routes it uses):
// GET <request-path>/health, POST <request-path>/inference → verbose_json. Test-only switches
// come before the real flags: --exit-code N (exit at once), --slow-start MS (health 503 first).
// A `die-once` file in the working directory makes the next inference kill the process (a crash
// under a request); the file is removed first, so the restarted server answers.
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const exitCode = flag("--exit-code");
if (exitCode !== undefined) process.exit(Number(exitCode));
const host = flag("--host") ?? "127.0.0.1";
const port = Number(flag("--port") ?? "8080");
const base = flag("--request-path") ?? "";
const model = flag("-m") ?? "";
const slow = Number(flag("--slow-start") ?? "0");
const startedAt = Date.now();

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === `${base}/health`) {
    const ready = Date.now() - startedAt >= slow;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(ready ? '{"status":"ok"}' : '{"status":"loading model"}');
    return;
  }
  if (req.method === "POST" && req.url === `${base}/inference`) {
    let bytes = 0;
    req.on("data", (b) => {
      bytes += b.length;
    });
    req.on("end", () => {
      if (existsSync("die-once")) {
        rmSync("die-once");
        req.socket.destroy();
        process.exit(3);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          text: " hello from fake",
          segments: [
            { text: ` heard ${bytes} bytes with ${model.split(/[\\/]/).pop()}`, start: 0, end: 1 },
          ],
        }),
      );
    });
    return;
  }
  res.writeHead(404);
  res.end("File Not Found");
});
server.on("error", (err) => {
  process.stderr.write(
    `\ncouldn't bind to server socket: hostname=${host} port=${port} ${err.message}\n`,
  );
  process.exit(1);
});
server.listen(port, host, () => {
  process.stdout.write(`\nwhisper server listening at http://${host}:${port}\n`);
});
