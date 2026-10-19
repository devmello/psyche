import { BRIDGE_TAG, bridgeScript, buildArtifactCsp, MAX_ARTIFACT_BYTES } from "./artifact.ts";

/**
 * React artifacts (P6, ADR-013 "self-hosted Sandpack"). The app drives the frame with
 * `@codesandbox/sandpack-client` (Apache-2.0); the bundler it talks to is ours, served by the
 * Gateway on its own loopback origin, and speaks the subset of the Sandpack runtime protocol the
 * client uses (`initialized`, `register-frame`, `compile` → `start` / `status` / `action` /
 * `done`). It ships React 19 and Babel standalone from the Gateway's own `node_modules`, so
 * nothing is fetched from npm or a CDN. CodeSandbox's hosted bundler would fetch every
 * dependency from its packager CDN, which the "no external hosts" rule forbids; it stays usable
 * by pointing `bundlerUrl` at it, but Psyche never does.
 *
 * The bundler frame gets the same `sandbox="allow-scripts"` as every artifact (an opaque
 * origin), and the bundler page's CSP is `buildArtifactCsp` with the bundler origin as its only
 * library origin plus `'unsafe-eval'` (it evaluates what it transpiles); `connect-src 'none'`
 * still blocks every request, the bundler origin included.
 */

export const REACT_ARTIFACT_MIME = "application/vnd.psyche.artifact+react";

/** Bare imports the offline bundler can satisfy. Anything else fails with a clear message. */
export const REACT_ARTIFACT_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
] as const;

const SOURCE_RE = /\.(tsx|ts|jsx|js|css|json)$/;
const PATH_RE = /^\/[A-Za-z0-9_\-./]{1,200}$/;
const MAX_FILES = 64;

export type ReactArtifactFiles = Record<string, string>;

/**
 * A React artifact is either a single component (the default export renders) or JSON
 * `{"files": {"/App.tsx": "...", "/styles.css": "..."}}`. Paths are absolute, sources only.
 */
export function parseReactArtifact(source: string): ReactArtifactFiles {
  const trimmed = source.trimStart();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      parsed = undefined;
    }
    const files = (parsed as { files?: unknown } | undefined)?.files;
    if (typeof files === "object" && files !== null) {
      return validateReactFiles(
        Object.fromEntries(
          Object.entries(files as Record<string, unknown>).map(([k, v]) => [
            k,
            typeof v === "string" ? v : String((v as { code?: unknown })?.code ?? ""),
          ]),
        ),
      );
    }
  }
  return validateReactFiles({ "/App.tsx": source });
}

export function validateReactFiles(files: ReactArtifactFiles): ReactArtifactFiles {
  const entries = Object.entries(files);
  if (entries.length === 0) throw new TypeError("a React artifact needs at least one file");
  if (entries.length > MAX_FILES) throw new RangeError(`too many files (limit ${MAX_FILES})`);
  let bytes = 0;
  for (const [path, code] of entries) {
    if (!PATH_RE.test(path) || path.includes("..") || !SOURCE_RE.test(path)) {
      throw new TypeError(`unsupported artifact path: ${path.slice(0, 80)}`);
    }
    bytes += code.length;
  }
  if (bytes > MAX_ARTIFACT_BYTES) throw new RangeError("artifact too large");
  if (entryOf(files) === undefined) {
    throw new TypeError("a React artifact needs /index.(tsx|jsx|ts|js) or /App.(tsx|jsx|ts|js)");
  }
  return files;
}

const ENTRIES = ["/index.tsx", "/index.jsx", "/index.ts", "/index.js"];
const APPS = ["/App.tsx", "/App.jsx", "/App.ts", "/App.js"];

/** The module the bundler evaluates first: an explicit index, else a generated one for App. */
export function entryOf(files: ReactArtifactFiles): string | undefined {
  return (
    ENTRIES.find((p) => p in files) ?? (APPS.some((p) => p in files) ? GENERATED_ENTRY : undefined)
  );
}

const GENERATED_ENTRY = "/index.jsx";

export interface ReactSandboxSetup {
  files: Record<string, { code: string }>;
  entry: string;
  dependencies: Record<string, string>;
  template: "create-react-app-typescript";
}

/** The `SandboxSetup` handed to `SandpackRuntime` (files, entry, declared dependencies). */
export function reactSandboxSetup(files: ReactArtifactFiles): ReactSandboxSetup {
  const valid = validateReactFiles(files);
  const out: Record<string, { code: string }> = {};
  for (const [path, code] of Object.entries(valid)) out[path] = { code };
  const entry = entryOf(valid) as string;
  if (!(entry in out)) {
    const app = (APPS.find((p) => p in valid) as string).replace(/\.(tsx|jsx|ts|js)$/, "");
    // The bundler tracks every root created through react-dom/client and unmounts them all
    // before a recompile, so a user-written index works the same way.
    out[entry] = {
      code: `import { createRoot } from "react-dom/client";\nimport App from ".${app}";\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
    };
  }
  // package.json is what the Sandpack client reads; versions are the ones the bundler ships.
  out["/package.json"] = {
    code: JSON.stringify({ main: entry, dependencies: { react: "19", "react-dom": "19" } }),
  };
  return {
    files: out,
    entry,
    dependencies: { react: "19", "react-dom": "19" },
    template: "create-react-app-typescript",
  };
}

// ── Bundler page (served by the Gateway on the bundler origin) ──────────────────────

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/** Response headers for every bundler file. The page itself is framed only by the app. */
export function reactBundlerHeaders(
  opts: { appOrigin: string; bundlerOrigin: string },
  contentType = "text/html; charset=utf-8",
): Record<string, string> {
  if (!ORIGIN_RE.test(opts.appOrigin) || !ORIGIN_RE.test(opts.bundlerOrigin)) {
    throw new TypeError("appOrigin and bundlerOrigin must be http(s) origins");
  }
  const csp = buildArtifactCsp(
    { allowScripts: true, allowEval: true, libraryOrigins: [opts.bundlerOrigin] },
    "unused",
  );
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": `${csp}; frame-ancestors ${opts.appOrigin}`,
    // Scripts load cross-origin from an opaque-origin document.
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()",
  };
}

/** The bridge for a page whose channel arrives in the URL (`#channel=…`), not at build time. */
function hashBridge(): string {
  const placeholder = "__PSYCHE_CHANNEL__";
  return bridgeScript(placeholder).replace(
    JSON.stringify(placeholder),
    'decodeURIComponent((location.hash.match(/[#&]channel=([0-9a-f]{1,64})/)||[])[1]||"")',
  );
}

/** `/` on the bundler origin. Script paths are root-relative to the bundler origin. */
export function reactBundlerPage(): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<script>${hashBridge()}</script>`,
    '<script src="/vendor.js"></script>',
    '<script src="/babel.min.js"></script>',
    '<script src="/runtime.js"></script>',
    '</head><body><div id="root"></div></body></html>',
  ].join("");
}

/**
 * The bundler runtime (`/runtime.js`). Plain ES2017 so it runs as-is: transpiles each module with
 * Babel (React automatic runtime, TypeScript, CommonJS), resolves relative imports among the
 * artifact's files and bare imports against the vendored React, evaluates the entry, and reports
 * through the Sandpack protocol (to the client) and the Psyche bridge (`error`).
 */
export const REACT_BUNDLER_RUNTIME = `(function(){
"use strict";
var VENDOR=window.__psycheVendor||{},ALLOWED=${JSON.stringify(REACT_ARTIFACT_MODULES)},proc={env:{NODE_ENV:"production"}};
var C=decodeURIComponent((location.hash.match(/[#&]channel=([0-9a-f]{1,64})/)||[])[1]||""),id=null,styles=[],first=true;
function post(m){m.codesandbox=true;if(id!==null)m.$id=id;try{parent.postMessage(m,"*")}catch(e){}}
function bridge(m){m.tag=${JSON.stringify(BRIDGE_TAG)};m.channel=C;try{parent.postMessage(m,"*")}catch(e){}}
var vcache={};
function vendor(n){if(ALLOWED.indexOf(n)<0&&n!=="scheduler")return undefined;if(vcache[n])return vcache[n].exports;var f=VENDOR[n];if(typeof f!=="function")return undefined;var m={exports:{}};vcache[n]=m;f(m,m.exports,function(r){var v=vendor(r);if(v===undefined)throw new Error("module not found: "+r);return v},proc);
 if(n==="react-dom/client")m.exports=trackRoots(m.exports);return m.exports}
var roots=[];
function trackRoots(c){var o={};Object.keys(c).forEach(function(k){o[k]=c[k]});
 o.createRoot=function(){var r=c.createRoot.apply(c,arguments);roots.push(r);return r};
 o.hydrateRoot=function(){var r=c.hydrateRoot.apply(c,arguments);roots.push(r);return r};return o}
function norm(p){var o=[];p.split("/").forEach(function(s){if(s===""||s===".")return;if(s==="..")o.pop();else o.push(s)});return "/"+o.join("/")}
function dir(p){return p.slice(0,p.lastIndexOf("/"))||"/"}
var EXT=["",".tsx",".ts",".jsx",".js",".css",".json","/index.tsx","/index.ts","/index.jsx","/index.js"];
function fail(err,path){var msg=String(err&&err.message||err).slice(0,2000);var loc=err&&err.loc||{};
 post({type:"action",action:"show-error",title:path?"SyntaxError":"Error",path:path||"",message:msg,line:loc.line||0,column:loc.column||0,payload:{}});
 bridge({type:"error",message:msg.slice(0,500)});
 var pre=document.createElement("pre");pre.setAttribute("role","alert");pre.style.cssText="white-space:pre-wrap;color:#b42318;font:12px ui-monospace,monospace;padding:12px;margin:0";pre.textContent=msg;document.body.appendChild(pre)}
function reset(){roots.splice(0).forEach(function(r){try{r.unmount()}catch(e){}});styles.forEach(function(s){s.remove()});styles=[];
 Array.prototype.slice.call(document.body.children).forEach(function(n){n.remove()});var r=document.createElement("div");r.id="root";document.body.appendChild(r)}
function run(msg){
 if(typeof msg.$id==="number")id=msg.$id;
 post({type:"start",firstLoad:first});first=false;post({type:"status",status:"transpiling"});
 reset();var files={},mods=msg.modules||{};
 Object.keys(mods).forEach(function(k){var m=mods[k];files[norm(k)]=typeof m==="string"?m:String(m&&(m.code!=null?m.code:m.content)||"")});
 var pkg={};try{pkg=JSON.parse(files["/package.json"]||"{}")}catch(e){}
 var entry=norm(String(pkg.main||"/index.jsx")),cache={},current=null;
 function resolve(from,req){var b=norm(req.charAt(0)==="/"?req:dir(from)+"/"+req);for(var i=0;i<EXT.length;i++){if(Object.prototype.hasOwnProperty.call(files,b+EXT[i]))return b+EXT[i]}return null}
 function load(path){
  if(cache[path])return cache[path].exports;var m={exports:{}};cache[path]=m;var src=files[path];
  if(/\\.css$/.test(path)){var s=document.createElement("style");s.textContent=src;document.head.appendChild(s);styles.push(s);return m.exports}
  if(/\\.json$/.test(path)){m.exports=JSON.parse(src);return m.exports}
  var code;current=path;
  code=Babel.transform(src,{filename:path,presets:[["react",{runtime:"automatic"}],"typescript"],plugins:["transform-modules-commonjs"],sourceType:"module",babelrc:false,configFile:false}).code;
  current=null;
  var fn=new Function("module","exports","require","process",code+"\\n//# sourceURL=psyche-artifact://"+path);
  fn(m,m.exports,function(r){if(r.charAt(0)==="."||r.charAt(0)==="/"){var p=resolve(path,r);if(p===null)throw new Error("Cannot find module '"+r+"' from "+path);return load(p)}
   var v=vendor(r);if(v===undefined)throw new Error("'"+r+"' is not available offline. React artifacts can import "+ALLOWED.join(", ")+".");return v},proc);
  return m.exports}
 try{post({type:"status",status:"evaluating"});load(entry);post({type:"success"});post({type:"done",compilatonError:false})}
 catch(e){fail(e,current);post({type:"done",compilatonError:true})}
 post({type:"status",status:"idle"})}
addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=="object")return;
 if(d.type==="register-frame"&&typeof d.id==="number"){id=d.id;return}
 if(d.codesandbox!==true)return;if(d.type==="compile")run(d)});
addEventListener("error",function(e){post({type:"action",action:"show-error",title:"Error",message:String(e.message||"error").slice(0,2000),payload:{}})});
post({type:"initialized"});
})();`;
