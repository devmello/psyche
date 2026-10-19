# @psyche/protocol

**Owner:** S00 (bootstrap, then integrator). Changes only through additive `protocol:` PRs ([CHANGES.md](CHANGES.md)). Feature id: A3 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The contract everything compiles against: TypeBox schemas for the domain model, the WebSocket frames and method/event registry, the node and browser-bridge protocols, codegen for JSON Schema / TypeScript / Swift, and the TypeScript interfaces each subsystem implements (`src/contracts/`).

## Layout

| Path | What | Docs |
| --- | --- | --- |
| `src/common.ts` | Vocabulary: `SideEffect`, `TargetKind`, `Provenance`, `PermissionMode`, `Decision`, `GrantScope`, `DeviceScope`, `Usage`, ids, timestamps, `StringEnum` | architecture §4.3, §4.6 |
| `src/errors.ts` | `ErrorCode`, `ErrorPayload`, `PsycheError`, `NotImplementedError` | — |
| `src/schemas/` | Domain types (`Thread`, `Message`, `Block`, `Run`, `ToolCall`, `ToolSpec`, `Task`, `ApprovalRequest`, `Grant`, `Receipt`, …) | data model §1–§10 |
| `src/frames.ts` | `req` / `res` / `event` frames, `parseFrame` | architecture §11, data model §11 |
| `src/methods/`, `src/events.ts` | Typed method and event registry (`Methods`, `Events`) | architecture §11 |
| `src/node.ts` | Node protocol (`node.invoke`, `node.event`, `node.result`, capability manifest) | architecture §7 |
| `src/bridge.ts` | Desktop ↔ Gateway CDP bridge | architecture §5, §8 |
| `src/contracts/` | Cross-package interfaces; fakes live in `@psyche/testing` | see `src/contracts/README.md` |
| `scripts/gen.ts`, `generated/` | Codegen output (committed; CI checks freshness) | ADR-015 |

The binding wire details (handshake, signing payload, transports) are in [docs/plans/s00.md](../../docs/plans/s00.md) "Wire spec v1".

## Usage

```ts
import { Methods, type MethodParams, parseFrame, validateParams, Thread } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";

Value.Check(Thread, row); // runtime validation with the same schema the types come from
```

Every schema is a TypeBox value with a `$id`, so `Static<typeof X>` is the TypeScript type and the schema itself validates at runtime. String enums use `StringEnum` (plain `{type: "string", enum: [...]}`) so generated Swift gets real enums.

## Codegen

`pnpm protocol:gen` regenerates `generated/schema.json`, `generated/protocol.d.ts`, `generated/swift/PsycheProtocol.swift` and the copy in `apps/mac-helper`. `pnpm protocol:check` fails if any of them is stale. See `generated/README.md`.

## Rules

- Erasable TypeScript only (no `enum`, `namespace`, parameter properties) so sources run under Node's type stripping.
- Never put secret values in a schema; credentials appear only as metadata or `{{cred:slug}}` placeholders.
- Additive changes only until v1.
