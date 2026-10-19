/** True in Node (Gateway, tests); false in browsers and the sandboxed Electron renderer. */
export const isNodeRuntime = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  "string";
