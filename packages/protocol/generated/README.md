# Generated protocol artifacts

Do not edit these files. They are written by `scripts/gen.ts` from the TypeBox schemas in `src/`:

```sh
pnpm protocol:gen     # regenerate
pnpm protocol:check   # CI: exit 1 and list stale files
```

| File | What | Generator |
| --- | --- | --- |
| `schema.json` | JSON Schema draft 2020-12: one `$defs` entry per schema `$id` (method params/results and event payloads without an `$id` are named `<Method>Params`, `<Method>Result`, `<Event>Payload`), plus `x-psyche` listing every method (`name`, `scope`, `sideEffecting`, `params`, `result`), event and browser-bridge method/event, and `protocolVersion` | own walk of the TypeBox exports |
| `protocol.d.ts` | TypeScript declarations for non-workspace consumers | `quicktype-core` 26, `typescript`, `just-types` |
| `swift/PsycheProtocol.swift` | Swift `Codable`, `Sendable`, `public` structs and enums; also copied to `apps/mac-helper/Sources/PsycheProtocol/PsycheProtocol.generated.swift` | `quicktype-core` 26, `swift`, `struct-or-class: struct`, `access-level: public`, `sendable`, no Alamofire, no convenience initializers |

Why: the OpenClaw recipe (ADR-015). Our own step keeps `schema.json` exact and deterministic;
quicktype saves writing a Swift emitter. Output is byte-identical across runs and platforms
(sorted keys and names, LF line endings, trailing newline).

Known limits of the quicktype outputs:

- `anyOf` unions of objects (for example `Block`, `Frame`, `ConnectResult`) become one struct /
  interface with the discriminant plus every variant's fields as optional. Switch on the
  discriminant (`type`, `phase`, `ok`) before reading variant fields.
- Literal `true` / `false` (`ok`, `accepted`) become plain booleans; validation-only keywords
  (`pattern`, lengths, item counts) are not carried into the types.
- Untyped JSON (`params`, `payload`, settings values) is `JSONAny` in Swift and `unknown` in
  TypeScript. The generator marks quicktype's helper classes `final` and `Sendable` so the file
  type-checks in Swift 6 language mode.

Workspace TypeScript code should import the types from `@psyche/protocol` (TypeBox `Static`
types, exact unions) rather than from `protocol.d.ts`.
