---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/db": minor
"@psyche/testing": minor
---

The Linux helper can pair with the Gateway. It is the Host's own helper only on the local node socket with this launch's handshake secret (stored as `host-helper`), and anywhere else a `linux-helper` is just a remote node. On Linux the Gateway also looks at the process on the other end of the node socket before reading from it (`root_owned`, `user_owned`, `unverified`, or `mismatch`, which is refused) and shows the result in `devices.hostHelper.status`. New: the `linux-helper` family, `hostHelperKindOf`, the `PeerCheck` type, a migration that lets `nodes.kind` hold `host-helper` and `guest`, and a "host helper" conformance profile.
