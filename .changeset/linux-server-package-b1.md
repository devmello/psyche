---
"@psyche/gateway": minor
"@psyche/cli": minor
---

psyche-server: a deb, rpm and tarball that run Psyche's Gateway, the CLI and the helper as a headless Linux Host, with no Electron. The Gateway's peer check now accepts the server package's root-owned helper (`/usr/lib/psyche-server/psyche-helper`) as a second packaged path, walked up to its own package root. `psyche update` updates a psyche-server install from the signed update manifest after a pre-update snapshot of the data (`psyched snapshot <version>`): the tarball in place, with a rollback when the new Gateway does not come up, and deb or rpm by printing the `apt` or `dnf` command.
