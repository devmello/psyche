# Cookie import (2026)

Cowork parity audit row 15. The owner brings sign-ins from their own browser into Psyche's
agent browser profile (`persist:agent-<name>`), so a task is signed in where the owner is.

## Owner-facing flow

Settings → Browser → **Import sign-ins from another browser** (desktop only):

1. Pick a browser: Chrome, Brave, Edge, Arc or Firefox. Safari is listed as not supported: its
   cookie file sits in Safari's container, which needs Full Disk Access, and Psyche doesn't ask
   for that.
2. Pick a profile when the browser has more than one (Chromium's `Local State`, Firefox's
   `profiles.ini`).
3. **Read sign-ins.** For a Chromium browser macOS shows its own Keychain prompt for
   "<Browser> Safe Storage". Psyche never sees the Keychain password beyond the call.
4. A list of sites, grouped by registrable domain (`mail.google.com` and `accounts.google.com`
   are one row, `google.com`; `evil-google.com` is its own row), with a search box and cookie
   counts. **Nothing is ticked.** "Select all" ticks every site except the sensitive ones:
   banks, payment services, password managers and email providers carry a warning and must be
   ticked one by one.
5. **Import N sites** writes the chosen cookies into Psyche's profile. The list of what was
   read is dropped from memory right after, or after 10 minutes, or on Cancel.
6. **Imported sign-ins** lists each imported site with **Remove imported sign-ins**, which
   deletes exactly the cookies the import wrote (by domain, path and name).

## How it reads and writes

- **Chromium family** (Chrome, Brave, Edge, Arc): the profile's `Network/Cookies` (or the older
  `Cookies`) SQLite file and its `-wal`/`-journal` are copied into a private temp dir
  (`0700`); only the copy is opened, and the copy is deleted afterwards. `v10` values are
  AES-128-CBC with a key from PBKDF2-SHA1(the Keychain password, `saltysalt`, 1003 rounds).
  From cookie DB version 24 the plaintext starts with SHA-256 of the host, which is checked
  and stripped.
- **Firefox**: `cookies.sqlite` (plus `-wal`), copied the same way; values are plain text.
  Only the default container (empty `originAttributes`) is read.
- Expired cookies and partitioned cookies (CHIPS, Firefox partition keys) are skipped.
- **Writing** goes only into Psyche's own profile through Electron's cookie store
  (`session.cookies.set`), keeping `httpOnly`, `secure`, `sameSite` and the expiry. A session
  cookie gets the profile's usual 30-day lifetime (the same rule as "Stay signed in"), since a
  session cookie in a persistent profile is otherwise gone on the next start. The source
  browser's files are never written.
- macOS only for now. Windows (DPAPI) and Linux (libsecret) keys are a follow-up; other
  platforms list every browser as not supported.

## Threat model

| Threat | Answer |
| --- | --- |
| The agent, an MCP server, a widget, a channel or a paired phone starts an import to steal sessions | There is no tool and no Gateway method that imports. The code runs in the desktop main process, behind IPC channels only the app's own windows reach (`trusted()` checks the sender and its frame URL). With a remote Gateway the channels are refused. |
| A page in an agent tab calls the IPC | Agent tabs are sandboxed `WebContentsView`s without the preload; `trusted()` refuses their senders. |
| Decrypted values leak | Values stay in main-process memory between Read and Import and never cross IPC: the renderer gets domains, counts and flags. Errors are fixed strings. Nothing is logged. The audit gets counts and domains only. Tests grep captured logs, the audit text and the IPC results for the fixture values. |
| The import copies too much | Nothing is ticked by default; sensitive domains carry a warning and are left out of "Select all". The owner sees the domain list before anything is written. |
| An imported site gains trust | The import writes cookies only. It never adds a "Stay signed in" entry, a site-trust offer or an approval rule, and payment checks are unchanged: a payment on an imported site still needs Touch ID or the password. The profile's cookie watcher lists the site under Signed-in sites like any sign-in the owner made in Psyche. |
| A forged audit entry | `browser.cookieImport.record` is `operator.admin` and accepts only the desktop shell's own connection (`identity.desktopShell`); the renderer cannot call it (`checkCallable`). It writes an audit entry and does nothing else. |
| The source browser is damaged or locked | Only copies are opened; the source files are read once with `copyFileSync`. |
| Keychain access | macOS asks the owner in its own prompt for each browser's Safe Storage item. Tests inject the key and never call `security`. |

Residual: anyone at the unlocked Mac with the Psyche window open can import, and so could they
by opening the source browser itself.
