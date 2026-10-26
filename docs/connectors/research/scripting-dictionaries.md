# Scripting dictionaries on macOS 27.0.1 (first-hand)

Read on 2026-10-25 with `sdef <app bundle>` on macOS 27.0.1 (build 26A434). `sdef` reads the dictionary from the app bundle; it does not launch the app or send Apple Events, so it needs no TCC grant. The lists below leave out the Standard Suite (`open`, `close`, `save`, `count`, `delete`, `duplicate`, `exists`, `make`, `move`, `get`, `set`), the Text Suite and the type definitions, which every scriptable app shares. Every command and class here is reachable through the helper's existing in-process `OSAScript` route (`ScriptHandler.call`: fixed script text, inputs as handler arguments, Automation asked per target app).

Apps that ship **no** dictionary on this Mac: Podcasts, Maps, Freeform, Voice Memos, Weather, Books. For these, the only routes are App Intents through Shortcuts (`shortcuts run`), their own frameworks (MapKit/WeatherKit for data, not for the app), or read-only stores. Keynote, Pages and Numbers are not installed here; they have rich dictionaries when installed.

## What stands out

- **Mail** can already do far more than Psyche exposes: `reply`, `forward`, `redirect`, `flagged status` and `flag index`, `read status`, `junk mail status`, `deleted status`, `move` to a mailbox, `mail attachment` elements (save to disk), per-mailbox `unread count`, `selected messages` of the message viewer, `rule` with conditions and actions, and signatures.
- **Notes** has folders, accounts, `body` (HTML) and `plaintext`, `attachment` elements, and `set body`, which is how append and edit work. There is no search command, but `notes whose name contains …` / `plaintext contains …` works through `whose`.
- **Reminders** (scripting) has `flagged`, `priority`, `remind me date`, `allday due date`, `body` and list `color` / `emblem`. Tags, subtasks, sections and location triggers are **not** in the dictionary. They are in EventKit only partly (alarms, structured locations) and in App Intents (tags, subtasks) only.
- **Calendar** (scripting) exposes attendees with `participation status`, four alarm kinds, `recurrence` (RRULE text) and `excluded dates`; EventKit covers the same with typed APIs and is what the helper uses.
- **Contacts** has a complete dictionary (person, group, every field kind, vCard) and also the Contacts framework; prefer the framework.
- **Photos** can `search`, `export`, `import`, and work with albums, folders, keywords, favorites and `spotlight`. PhotoKit gives the same with limited-library support.
- **Music** has playback control, `search`, playlists, `add`, AirPlay devices, the current track and player state. **Spotify** has playback and the current track only (no search or playlists: use the Web API).
- **Safari** has `add reading list item`, tab `text` and `source` (page text without a browser automation stack), `do JavaScript` (powerful; Psyche should not expose it to the model), and `search the web`.
- **Shortcuts Events** has `run` on a `shortcut` with `accepts input` and `action count`, and folders. The `shortcuts` CLI (`run`, `list`, `--input-path`, `--output-path`, `--output-type`) is the same bridge from a shell.
- **Messages** has `send`, chats and participants (Psyche's iMessage channel uses the chat database for reading).
- **Finder** has `reveal`, `sort`, `empty` (Trash), `eject`, selection, `entire contents`, comments and label index (tags are Spotlight metadata, not in the dictionary).
- **Terminal** has `do script` (not something the model should get), and tab `contents` / `history`. **Google Chrome** has tabs (title, URL), bookmarks, and `execute` (JavaScript; same caution as Safari). **Xcode** has scheme actions (build, test, run).

## Per app

### Calendar

- Commands: `create calendar`, `reload calendars`, `switch view`, `view calendar`, `GetURL`, `show`, `make`, `save`
- `calendar`: elements event; properties name, title, color, calendarIdentifier, writable, description
- `display alarm`: properties trigger interval, trigger date
- `mail alarm`: properties trigger interval, trigger date
- `sound alarm`: properties trigger interval, trigger date, sound name, sound file
- `open file alarm`: properties trigger interval, trigger date, filepath
- `attendee`: properties display name, email, participation status
- `event`: elements attendee, display alarm, mail alarm, open file alarm, sound alarm; properties description, start date, end date, allday event, recurrence, sequence, stamp date, excluded dates, status, summary, location, uid, url
- `+application`: elements calendar

### Contacts

- Commands: `add`, `remove`, `save`, `action property`, `action title`, `perform action`, `should enable action`
- `address`: properties city, formatted address, street, id, zip, country, label, country code, state
- `AIM Handle`: (no properties)
- `contact info`: properties label, value, id
- `custom date`: (no properties)
- `email`: (no properties)
- `entry`: properties modification date, creation date, id, selected
- `group`: elements group, person; properties name
- `ICQ handle`: (no properties)
- `instant message`: properties service name, service type, user name
- `Jabber handle`: (no properties)
- `MSN handle`: (no properties)
- `person`: elements MSN handle, url, address, phone, Jabber handle, group, custom date, AIM Handle, Yahoo handle, ICQ handle; properties nickname, organization, maiden name, suffix, vcard, home page, birth date, phonetic last name, title, phonetic middle name, department, image, name, note, company, middle name, phonetic first name, job title …
- `phone`: (no properties)
- `related name`: (no properties)

### Finder

- Commands: `openVirtualLocation`, `copy`, `sort`, `clean up`, `eject`, `empty`, `erase`, `reveal`, `update`, `restart`, `shut down`, `sleep`
- `application`: elements item, container, disk, folder, file, alias file, application file, document file, internet location file, clipping; properties clipboard, name, visible, frontmost, selection, insertion location, product version, version, startup disk, desktop, trash, home, computer container, Finder preferences
- `item`: properties name, displayed name, name extension, extension hidden, index, container, disk, position, desktop position, bounds, label index, locked, kind, description, comment, size, physical size, creation date …
- `container`: elements item, container, folder, file, alias file, application file, document file, internet location file, clipping, package; properties entire contents, expandable, expanded, completely expanded, container window
- `computer-object`: (no properties)
- `disk`: elements item, container, folder, file, alias file, application file, document file, internet location file, clipping, package; properties id, capacity, free space, ejectable, local volume, startup, format, journaling enabled, ignore privileges
- `folder`: elements item, container, folder, file, alias file, application file, document file, internet location file, clipping, package
- `desktop-object`: elements item, container, disk, folder, file, alias file, application file, document file, internet location file, clipping
- `trash-object`: elements item, container, folder, file, alias file, application file, document file, internet location file, clipping, package; properties warns before emptying
- `file`: properties file type, creator type, stationery, product version, version
- `alias file`: properties original item
- `application file`: properties id, suggested size, minimum size, preferred size, accepts high level events, has scripting terminology, opens in Classic
- `document file`: (no properties)
- `internet location file`: properties location
- `clipping`: properties clipping window

### Google Chrome

- Commands: `reload`, `go back`, `go forward`, `select all`, `cut selection`, `copy selection`, `paste selection`, `undo`, `redo`, `stop`, `view source`, `execute`
- `tab`: properties id, title, URL, loading
- `bookmark folder`: elements bookmark folder, bookmark item; properties id, title, index
- `bookmark item`: properties id, title, URL, index
- `+application`: elements bookmark folder; properties bookmarks bar, other bookmarks

### Mail

- Commands: `bounce`, `check for new mail`, `extract name from`, `extract address from`, `forward`, `GetURL`, `import Mail mailbox`, `mailto`, `perform mail action with messages`, `redirect`, `reply`, `send`, `synchronize`
- `outgoing message`: elements bcc recipient, cc recipient, recipient, to recipient; properties sender, subject, visible, message signature, id, html content, vcard path
- `ldap server`: properties enabled, name, port, scope, search base, host name
- `OLD message editor`: properties OLD compose message
- `message viewer`: elements message; properties drafts mailbox, inbox, junk mailbox, outbox, sent mailbox, trash mailbox, sort column, sorted ascending, mailbox list visible, preview pane is visible, visible columns, id, visible messages, selected messages, selected mailboxes
- `signature`: properties content, name
- `+application`: elements account, pop account, imap account, iCloud account, smtp server, outgoing message, ldap server, mailbox, OLD message editor, message viewer; properties always bcc myself, always cc myself, selection, application version, fetch interval, background activity count, choose signature when composing, color quoted text, default message format, download html attachments, drafts mailbox, expand group addresses, fixed width font, fixed width font size, framework version, header detail, inbox, include all original message text …
- `message`: elements bcc recipient, cc recipient, recipient, to recipient, header, mail attachment; properties id, all headers, background color, mailbox, content, date received, date sent, deleted status, flagged status, flag index, junk mail status, read status, message id, source, reply to, message size, sender, subject …
- `account`: elements mailbox; properties delivery account, name, id, password, authentication, account type, email addresses, full name, empty junk messages frequency, empty sent messages frequency, empty trash frequency, empty junk messages on quit, empty sent messages on quit, empty trash on quit, enabled, user name, account directory, port …
- `imap account`: properties compact mailboxes when closing, message caching, store drafts on server, store junk mail on server, store sent messages on server, store deleted messages on server
- `iCloud account`: (no properties)
- `pop account`: properties big message warning size, delayed message deletion interval, delete mail on server, delete messages when moved from inbox
- `smtp server`: properties name, password, account type, authentication, enabled, user name, port, server name, uses ssl
- `mailbox`: elements mailbox, message; properties name, unread count, account, container
- `rule`: elements rule condition; properties color message, delete message, forward text, forward message, mark flagged, mark flag index, mark read, play sound, redirect message, reply text, run script, all conditions must be met, copy message, move message, highlight text using color, enabled, name, should copy message …

### Messages

- Commands: `send`, `login`, `logout`
- `participant`: properties id, account, name, handle, first name, last name, full name
- `account`: elements chat, participant; properties id, description, enabled, connection status, service type
- `chat`: elements participant; properties id, name, account
- `file transfer`: properties id, name, file path, direction, account, participant, file size, file progress, transfer status, started
- `+application`: elements participant, account, file transfer, chat

### Music

- Commands: `add`, `back track`, `convert`, `download`, `export`, `fast forward`, `next track`, `pause`, `play`, `playpause`, `previous track`, `refresh`, `resume`, `reveal`, `rewind`, `search`, `select`, `stop`, `open location`
- `AirPlay device`: properties active, available, kind, network address, protected, selected, supports audio, supports video, sound volume
- `application`: elements AirPlay device, browser window, encoder, EQ preset, EQ window, miniplayer window, playlist, playlist window, source, track; properties AirPlay enabled, converting, current AirPlay devices, current encoder, current EQ preset, current playlist, current stream title, current stream URL, current track, current visual, EQ enabled, fixed indexing, frontmost, full screen, name, mute, player position, player state …
- `artwork`: properties data, description, downloaded, format, kind, raw data
- `audio CD playlist`: elements audio CD track; properties artist, compilation, composer, disc count, disc number, genre, year
- `audio CD track`: properties location
- `browser window`: properties selection, view
- `encoder`: properties format
- `EQ preset`: properties band 1, band 2, band 3, band 4, band 5, band 6, band 7, band 8, band 9, band 10, modifiable, preamp, update tracks
- `EQ window`: (no properties)
- `file track`: properties location
- `folder playlist`: (no properties)
- `item`: properties class, container, id, index, name, persistent ID, properties
- `library playlist`: elements file track, URL track, shared track
- `miniplayer window`: (no properties)

### Notes

- Commands: `open note location`, `show`
- `account`: elements folder, note; properties default folder, name, upgraded, id
- `folder`: elements folder, note; properties name, id, shared, container
- `note`: elements attachment; properties name, id, container, body, plaintext, creation date, modification date, password protected, shared
- `attachment`: properties name, id, container, content identifier, creation date, modification date, URL, shared
- `+application`: elements account, folder, note, attachment; properties default account, selection

### Photos

- Commands: `import`, `export`, `duplicate`, `make`, `delete`, `add`, `start slideshow`, `stop slideshow`, `next slide`, `previous slide`, `pause slideshow`, `resume slideshow`, `spotlight`, `search`
- `media item`: properties keywords, name, description, favorite, date, id, height, width, filename, altitude, size, location
- `container`: properties id, name, parent
- `album`: elements media item
- `folder`: elements container, album, folder
- `moment`: elements media item; properties id, name
- `+application`: elements container, album, folder, media item, moment; properties selection, favorites album, last import album, slideshow running, recently deleted album

### Preview

- Commands: none beyond the standard suite

### QuickTime Player

- Commands: `open URL`, `play`, `start`, `pause`, `resume`, `stop`, `step backward`, `step forward`, `trim`, `present`, `new movie recording`, `new audio recording`, `new screen recording`, `export`, `show remote hud`
- `+application`: (no properties)
- `video recording device`: properties name, id
- `audio recording device`: properties name, id
- `audio compression preset`: properties name, id
- `movie compression preset`: properties name, id
- `screen compression preset`: properties name, id
- `+application`: elements video recording device, audio recording device, audio compression preset, movie compression preset, screen compression preset
- `+document`: properties audio volume, current time, data rate, data size, duration, looping, muted, natural dimensions, playing, rate, presenting, current microphone, current camera, current audio compression, current movie compression, current screen compression

### Reminders

- Commands: `show`
- `account`: elements list, reminder; properties id, name
- `list`: elements reminder; properties id, name, container, color, emblem
- `reminder`: properties name, id, container, creation date, modification date, body, completed, completion date, due date, allday due date, remind me date, priority, flagged
- `+application`: elements account, list, reminder; properties default account, default list

### Safari

- Commands: `add reading list item`, `do JavaScript`, `email contents`, `search the web`, `show bookmarks`, `show extensions preferences`, `dispatch message to extension`, `sync all plist to disk`, `show privacy report`, `show credit card settings`
- `tab`: properties source, URL, index, text, visible, name, pid
- `sourceProvider`: (no properties)
- `contentsProvider`: (no properties)
- `+window`: elements tab; properties current tab
- `+document`: properties source, URL, text

### Shortcuts Events

- Commands: `run`
- `shortcut`: properties name, subtitle, id, folder, color, icon, accepts input, action count
- `folder`: elements shortcut; properties name, id
- `+application`: elements shortcut, folder

### Spotify

- Commands: `next track`, `previous track`, `playpause`, `pause`, `play`, `play track`
- `application`: properties current track, sound volume, player state, player position, repeating enabled, repeating, shuffling enabled, shuffling
- `track`: properties artist, album, disc number, duration, played count, track number, starred, popularity, id, name, artwork url, artwork, album artist, spotify url

### TV

- Commands: `add`, `back track`, `convert`, `download`, `fast forward`, `next track`, `pause`, `play`, `playpause`, `previous track`, `refresh`, `resume`, `reveal`, `rewind`, `search`, `select`, `stop`, `open location`
- `application`: elements browser window, playlist, playlist window, source, track, video window, window; properties current playlist, current stream title, current stream URL, current track, fixed indexing, frontmost, full screen, name, mute, player position, player state, selection, sound volume, version
- `artwork`: properties data, description, downloaded, format, kind, raw data
- `browser window`: properties selection, view
- `file track`: properties location
- `folder playlist`: (no properties)
- `item`: properties class, container, id, index, name, persistent ID, properties
- `library playlist`: elements file track, URL track, shared track
- `playlist`: elements track, artwork; properties description, duration, name, parent, size, special kind, time, visible
- `playlist window`: properties selection, view
- `shared track`: (no properties)
- `source`: elements library playlist, playlist, user playlist; properties capacity, free space, kind
- `track`: elements artwork; properties album, album rating, album rating kind, bit rate, bookmark, bookmarkable, category, comment, database ID, date added, description, director, disc count, disc number, downloader account, downloader name, duration, enabled …
- `URL track`: properties address
- `user playlist`: elements file track, URL track, shared track; properties shared, smart

### Terminal

- Commands: `do script`, `get URL`
- `settings set`: properties id, name, number of rows, number of columns, cursor color, background color, normal text color, bold text color, font name, font size, font antialiasing, clean commands, title displays device name, title displays shell path, title displays window size, title displays settings name, title displays custom title, custom title
- `tab`: properties number of rows, number of columns, contents, history, busy, processes, selected, title displays custom title, custom title, tty, current settings, cursor color, background color, normal text color, bold text color, clean commands, title displays device name, title displays shell path …
- `+application`: elements settings set; properties default settings, startup settings

### Xcode

- Commands: `hack`, `create temporary debugging workspace`, `build`, `clean`, `stop`, `run`, `test`, `attach`, `debug`
- `+application`: elements file document, source document, workspace document; properties active workspace document
- `file document`: (no properties)
- `text document`: properties selected character range, selected paragraph range, text, notifies when closing
- `source document`: (no properties)
- `workspace document`: elements project, scheme, run destination, scheme action result; properties loaded, active scheme, active run destination, last scheme action result, file
- `+document`: properties path
- `scheme action result`: elements build error, build warning, analyzer issue, test failure; properties id, completed, status, error message, build log
- `scheme action issue`: properties message, file path, starting line number, ending line number, starting column number, ending column number
- `build error`: (no properties)
- `build warning`: (no properties)
- `analyzer issue`: (no properties)
- `test failure`: (no properties)
- `scheme`: properties name, id
- `run destination`: properties name, architecture, platform, device, companion device
