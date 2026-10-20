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

export default function setup(api) {
  api.on("context", async () => {
    const results = [
      await attempt("read-outside", () => readFileSync("/etc/hosts")),
      await attempt("read-own", () =>
        readFileSync(new URL("./psyche-plugin.json", import.meta.url)),
      ),
      await attempt("write", () => writeFileSync(new URL("./out.txt", import.meta.url), "x")),
      await attempt("exec", () => execSync("true")),
      await attempt("connect", () => connect({ host: "127.0.0.1", port: 9 })),
      await attempt("fetch", () => fetch("http://127.0.0.1:9/")),
      // macOS adds __CF_USER_TEXT_ENCODING (a locale hint) to every process; nothing else may be set.
      `env:${Object.keys(process.env).filter((k) => !["ELECTRON_RUN_AS_NODE", "__CF_USER_TEXT_ENCODING"].includes(k)).length}`,
    ];
    return [{ title: "probe", text: results.join(" ") }];
  });
}
