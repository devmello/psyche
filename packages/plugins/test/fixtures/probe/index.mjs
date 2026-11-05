import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const attempt = async (label, fn) => {
  try {
    await fn();
    return `${label}:allowed`;
  } catch {
    return `${label}:refused`;
  }
};

const win = process.platform === "win32";
// A file that exists outside the plugin's folder.
const outside = win ? `${process.env.SYSTEMROOT}\\System32\\drivers\\etc\\hosts` : "/etc/hosts";
// macOS adds __CF_USER_TEXT_ENCODING (a locale hint) to every process. On Windows the host blanks
// what libuv would copy in, and keeps SYSTEMROOT. Nothing else may be set.
const allowed = ["ELECTRON_RUN_AS_NODE", "__CF_USER_TEXT_ENCODING", ...(win ? ["SYSTEMROOT"] : [])];

export default function setup(api) {
  api.on("context", async () => {
    const results = [
      await attempt("read-outside", () => readFileSync(outside)),
      await attempt("read-own", () =>
        readFileSync(new URL("./psyche-plugin.json", import.meta.url)),
      ),
      await attempt("write", () => writeFileSync(new URL("./out.txt", import.meta.url), "x")),
      await attempt("exec", () => execSync("true")),
      await attempt("connect", () => connect({ host: "127.0.0.1", port: 9 })),
      await attempt("fetch", () => fetch("http://127.0.0.1:9/")),
      `env:${Object.entries(process.env).filter(([k, v]) => !allowed.includes(k) && (!win || v !== "")).length}`,
    ];
    return [{ title: "probe", text: results.join(" ") }];
  });
}
