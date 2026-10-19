import { describe, expect, it } from "vitest";
import { reactBundlerResponse } from "../src/bundler/index.ts";
import {
  entryOf,
  parseReactArtifact,
  REACT_BUNDLER_RUNTIME,
  reactBundlerHeaders,
  reactBundlerPage,
  reactSandboxSetup,
} from "../src/core/react-artifact.ts";
import { createDefaultViewerRegistry } from "../src/core/registry.ts";

const origins = { appOrigin: "http://127.0.0.1:4317", bundlerOrigin: "http://127.0.0.1:4318" };

describe("React artifact sources", () => {
  it("treats plain source as /App.tsx and JSON as a file map", () => {
    expect(parseReactArtifact("export default () => <p/>")).toEqual({
      "/App.tsx": "export default () => <p/>",
    });
    const files = parseReactArtifact(
      JSON.stringify({
        files: { "/index.tsx": "x", "/styles.css": "p{}", "/lib/util.ts": { code: "y" } },
      }),
    );
    expect(files).toEqual({ "/index.tsx": "x", "/styles.css": "p{}", "/lib/util.ts": "y" });
  });

  it("refuses odd paths, missing entries and oversize artifacts", () => {
    expect(() => parseReactArtifact(JSON.stringify({ files: { "/../x.tsx": "" } }))).toThrow(
      /path/,
    );
    expect(() => parseReactArtifact(JSON.stringify({ files: { "/a.exe": "" } }))).toThrow(/path/);
    expect(() => parseReactArtifact(JSON.stringify({ files: { "/util.ts": "" } }))).toThrow(
      /needs/,
    );
    expect(() => parseReactArtifact("x".repeat(6 * 1024 * 1024))).toThrow(/too large/);
  });

  it("generates an entry for an App and declares the vendored React", () => {
    expect(entryOf({ "/App.jsx": "" })).toBe("/index.jsx");
    expect(entryOf({ "/index.tsx": "", "/App.tsx": "" })).toBe("/index.tsx");
    const setup = reactSandboxSetup({ "/App.tsx": "export default () => null" });
    expect(setup.entry).toBe("/index.jsx");
    expect(setup.files["/index.jsx"]?.code).toContain('import App from "./App"');
    expect(setup.files["/index.jsx"]?.code).toContain("__psycheRoot");
    expect(JSON.parse(setup.files["/package.json"]?.code ?? "{}").main).toBe("/index.jsx");
    expect(setup.dependencies).toEqual({ react: "19", "react-dom": "19" });
  });

  it("is registered as an artifact", () => {
    const spec = createDefaultViewerRegistry().resolve(
      "application/vnd.psyche.artifact+react",
      "dash",
    );
    expect(spec?.render).toBe("artifact");
  });
});

describe("self-hosted bundler", () => {
  it("serves its page under the artifact CSP with eval and only its own origin", () => {
    const h = reactBundlerHeaders(origins);
    const csp = h["Content-Security-Policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'unsafe-inline' 'unsafe-eval' ${origins.bundlerOrigin}`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain(`frame-ancestors ${origins.appOrigin}`);
    expect(csp).not.toContain("https:");
    expect(() => reactBundlerHeaders({ ...origins, appOrigin: "*" })).toThrow();
  });

  it("loads only root-relative scripts and reads the channel from the fragment", () => {
    const page = reactBundlerPage();
    const srcs = [...page.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual(["/vendor.js", "/babel.min.js", "/runtime.js"]);
    expect(page).toContain("location.hash.match");
    expect(REACT_BUNDLER_RUNTIME).toContain('post({type:"initialized"})');
    expect(REACT_BUNDLER_RUNTIME).toContain("e.source!==parent");
  });

  it("serves vendored React and Babel from local files, nothing else", async () => {
    const vendor = await reactBundlerResponse("/vendor.js", origins);
    for (const id of ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "scheduler"]) {
      expect(vendor?.body).toContain(
        `V[${JSON.stringify(id)}]=function(module,exports,require,process){`,
      );
    }
    expect(vendor?.headers["Content-Type"]).toMatch(/javascript/);
    const babel = await reactBundlerResponse("/babel.min.js?x=1", origins);
    expect(babel?.body.length).toBeGreaterThan(1_000_000);
    expect((await reactBundlerResponse("/", origins))?.headers["Content-Type"]).toMatch(/html/);
    expect(await reactBundlerResponse("/etc/passwd", origins)).toBeUndefined();
    expect(await reactBundlerResponse("/../package.json", origins)).toBeUndefined();
  });

  it("vendors no remote URL a module could fetch at load", async () => {
    const vendor = (await reactBundlerResponse("/vendor.js", origins))?.body ?? "";
    // React's production builds only mention URLs in error-decoder text and XML namespaces.
    const urls = [...vendor.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(
      urls.every(
        (u) => u.startsWith("https://react.dev/errors/") || u.startsWith("http://www.w3.org/"),
      ),
    ).toBe(true);
  });
});
