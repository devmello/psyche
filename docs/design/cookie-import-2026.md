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
4. A list of sites, grouped by registrable domain under the full public suffix list, ICANN and
   private sections (`tldts`, pinned): `mail.google.com` and `accounts.google.com` are one row,
   `google.com`; `evil-google.com` is its own row; `a.github.io` and `b.github.io` are two rows,
   as are `maybank2u.com.my` and `shopee.com.my`; a bare public suffix is never a row. Each row
   lists the hosts inside it, with a search box and cookie counts. **Nothing is ticked.**
   Sensitivity is judged per cookie host and a row is sensitive when any host in it is: banks,
   brokerages, exchanges and money transfer services (the financial hard block's venue table,
   `venueOfHost`, plus a few hand-kept lists), payment services, password managers, email
   providers and sign-in providers (Okta, GitHub, accounts.google.com,
   login.microsoftonline.com). "Select all" ticks every site except the sensitive ones; those
   carry a warning and must be ticked one by one. **Main enforces this**: `import` refuses a
   sensitive domain unless the call names it in a separate `sensitive` list, which the window
   sends only for the rows the owner ticked.
5. **Import N sites** writes the chosen cookies into Psyche's profile. The list of what was
   read is dropped from memory right after, or after 10 minutes, or on Cancel.
6. **Imported sign-ins** lists each imported site with **Remove imported sign-ins**, which
   deletes the cookies the import wrote, matched by name, domain and path exactly. A cookie of
   the same name on a parent domain or a shorter path is put back, and the count is of cookies
   that were really there. It is not a sign-out: cookies the site issued since, under other
   names, stay; Signed-in sites → Forget signs out. Import and Remove run one at a time.

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

| Threat                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The agent, an MCP server, a widget, a channel or a paired phone starts an import to steal sessions | There is no tool and no Gateway method that imports. The code runs in the desktop main process, behind six IPC channels that only the main window and the Settings window reach (`isApprovalContents` plus the frame URL check; never pop-outs, quick entry or the screen-ask window). With a remote Gateway the channels are refused.                                                                                                                                                                                                                                                                                                                       |
| A page in an agent tab calls the IPC                                                               | Agent tabs are sandboxed `WebContentsView`s without the preload; `trusted()` refuses their senders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Decrypted values leak                                                                              | Values stay in main-process memory between Read and Import and never cross IPC: the renderer gets domains, counts and flags. Errors are fixed strings. Nothing is logged. The audit gets counts and domains only. Tests grep captured logs, the audit text and the IPC results for the fixture values.                                                                                                                                                                                                                                                                                                                                                       |
| The import copies too much                                                                         | Nothing is ticked by default; sensitive domains carry a warning and are left out of "Select all", and main refuses a sensitive domain the call doesn't name. The owner sees the domain and host list before anything is written.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| An imported site gains trust                                                                       | The import writes cookies only. It never adds a "Stay signed in" entry, a site-trust offer or an approval rule, and payment checks are unchanged: a payment on an imported site still needs Touch ID or the password. Everything else follows the owner's approval mode, so in Auto mode a message sent from an imported mail session may not ask; the copy says so. The profile's cookie watcher lists the site under Signed-in sites like any sign-in the owner made in Psyche.                                                                                                                                                                            |
| The audit is lost                                                                                  | Main writes a value-free entry (action, browser, domains, counts) to `$PSYCHE_HOME/browser/cookie-import-audit.json` (0600, atomic, bounded: 500 entries, 5000 sites each, 8 MiB) before it touches a cookie, and settles it with the real counts afterwards. When the Gateway is down, or the desktop isn't admin yet, the entry stays. Main flushes the queue in order when this Mac's own Gateway connects with `operator.admin` (and again on every reconnect), deleting an entry only after the Gateway answers ok. It never flushes to a remote Gateway: domain lists don't leave this Mac. A full queue refuses the import rather than drop a record. |
| A forged audit entry                                                                               | `browser.cookieImport.record` is `operator.admin` and accepts only the desktop shell's own connection (`identity.desktopShell`); the renderer cannot call it (`checkCallable`). It writes an audit entry and does nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The source browser is damaged or locked                                                            | Only copies are opened; the source files are read once with `copyFileSync`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Keychain access                                                                                    | macOS asks the owner in its own prompt for each browser's Safe Storage item, looked up by service and account (`-a`) so another app's look-alike item isn't read. Tests inject the key and never call `security`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Temp copies                                                                                        | Copies and their `-wal`/`-journal` sidecars are `0600` in a `0700` folder, removed in a `finally`; stale `psyche-cookie-import-*` folders a crash left are swept when the importer is made.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Residual: anyone at the unlocked Mac with the Psyche window open can import, and so could they
by opening the source browser itself.
