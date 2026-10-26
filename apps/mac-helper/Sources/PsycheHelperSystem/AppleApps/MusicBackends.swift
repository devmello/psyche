import AppKit
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Music and Spotify wave 1 (U1–U2) behind a protocol, so capabilities are tested with a fake.
public protocol MusicBackend: Sendable {
    /// `app` nil: whichever is playing, else Music. Never launches a player.
    func nowPlaying(app: String?) async throws -> NowPlayingRecord
    func control(app: String?, action: String, volume: Int?, shuffle: Bool?) async throws -> NowPlayingRecord
    /// The owner's Music library, best match first.
    func searchLibrary(query: String, kind: String?, limit: Int) async throws -> [MusicItemRecord]
    func play(kind: String, id: String, shuffle: Bool?) async throws -> NowPlayingRecord
}

/// Music and Spotify scripting: fixed script text, inputs as handler arguments.
public final class MusicScriptingBackend: MusicBackend, @unchecked Sendable {
    static let bundleIds = ["music": "com.apple.Music", "spotify": "com.spotify.client"]
    static let appNames = ["music": "Music", "spotify": "Spotify"]

    /// The same handlers for both players (their dictionaries share these terms); `appName` picks one.
    static func source(_ app: String) -> String {
        let name = appNames[app] ?? "Music"
        let shuffleProp = app == "spotify" ? "shuffling" : "shuffle enabled"
        return ScriptHandler.prelude + """
            on psyche_now()
              set fs to character id 31
              tell application "\(name)"
                set pstate to (player state as text)
                if pstate is "stopped" then return pstate & fs & "" & fs & "" & fs & "" & fs & "" & fs & "" & fs & (sound volume as text) & fs & (\(shuffleProp) as text)
                set t to current track
                set pos to player position
                return pstate & fs & my psyche_clean(name of t) & fs & my psyche_clean(artist of t) & fs & my psyche_clean(album of t) & fs & (duration of t as text) & fs & (pos as text) & fs & (sound volume as text) & fs & (\(shuffleProp) as text)
              end tell
            end psyche_now
            on psyche_control(act, vol, shuf)
              tell application "\(name)"
                if act is "play" then play
                if act is "pause" then pause
                if act is "playpause" then playpause
                if act is "next" then next track
                if act is "previous" then previous track
                if act is "volume" then set sound volume to (vol as integer)
                if act is "shuffle" then set \(shuffleProp) to (shuf is "true")
              end tell
              return "ok"
            end psyche_control
            """
    }

    static let libraryScript = ScriptHandler.prelude + """
        on psyche_tracks(q, onlyKind, lim)
          set fs to character id 31
          set out to {}
          tell application "Music"
            if onlyKind is "albums" then
              set found to search library playlist 1 for q only albums
            else if onlyKind is "artists" then
              set found to search library playlist 1 for q only artists
            else
              set found to search library playlist 1 for q only songs
            end if
            set n to 0
            repeat with t in found
              if n ≥ (lim as integer) then exit repeat
              set end of out to (persistent ID of t) & fs & my psyche_clean(name of t) & fs & my psyche_clean(artist of t) & fs & my psyche_clean(album of t) & fs & my psyche_clean(album artist of t)
              set n to n + 1
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_tracks
        on psyche_playlists(q)
          set fs to character id 31
          set out to {}
          tell application "Music"
            repeat with p in (user playlists whose name contains q)
              set end of out to (persistent ID of p) & fs & my psyche_clean(name of p) & fs & ((count of tracks of p) as text)
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_playlists
        on psyche_play_track(pid)
          tell application "Music" to play (first track of library playlist 1 whose persistent ID is pid)
          return "ok"
        end psyche_play_track
        on psyche_play_playlist(pid, shuf)
          tell application "Music"
            if shuf is "true" then set shuffle enabled to true
            if shuf is "false" then set shuffle enabled to false
            play (first user playlist whose persistent ID is pid)
          end tell
          return "ok"
        end psyche_play_playlist
        -- Albums and artists play through one reusable playlist named "Psyche" (Music cannot
        -- queue an album through scripting); only that playlist's contents change.
        on psyche_play_set(kindName, artistName, albumName, shuf)
          tell application "Music"
            if not (exists user playlist "Psyche") then make new user playlist with properties {name:"Psyche"}
            set p to user playlist "Psyche"
            delete tracks of p
            if kindName is "album" then
              set ts to (tracks of library playlist 1 whose album is albumName and album artist is artistName)
              if (count of ts) is 0 then set ts to (tracks of library playlist 1 whose album is albumName and artist is artistName)
            else
              set ts to (tracks of library playlist 1 whose artist is artistName or album artist is artistName)
            end if
            if (count of ts) is 0 then return "empty"
            repeat with t in ts
              duplicate t to p
            end repeat
            if shuf is "true" then set shuffle enabled to true
            if shuf is "false" then set shuffle enabled to false
            play p
          end tell
          return "ok"
        end psyche_play_set
        """

    public init() {}

    static func running(_ app: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIds[app] ?? "").isEmpty
    }

    func read(_ app: String) async throws -> NowPlayingRecord {
        guard Self.running(app) else { return .stopped(app) }
        let out = try await ScriptHandler.call(Self.source(app), handler: "psyche_now", [], app: Self.bundleIds[app]!)
        let f = (out ?? "").components(separatedBy: ScriptRecords.fieldSeparator)
        guard f.count == 8 else { return .stopped(app) }
        let state = ["playing", "paused"].contains(f[0]) ? f[0] : "stopped"
        let track = f[1].isEmpty ? nil : NowPlayingRecord.Track(name: f[1], artist: f[2], album: f[3], durationSeconds: MusicWave1.seconds(f[4], app: app),
                                                                  positionSeconds: MusicWave1.seconds(f[5], app: "music"))
        return NowPlayingRecord(app: app, state: state, track: state == "stopped" ? nil : track, volume: Int(f[6]), shuffle: f[7] == "true")
    }

    /// Whichever player is playing, else Music.
    func pick(_ app: String?) async throws -> String {
        if let app { return app }
        if Self.running("spotify"), try await read("spotify").state == "playing" { return "spotify" }
        return "music"
    }

    public func nowPlaying(app: String?) async throws -> NowPlayingRecord { try await read(try await pick(app)) }

    public func control(app: String?, action: String, volume: Int?, shuffle: Bool?) async throws -> NowPlayingRecord {
        let a = try await pick(app)
        // Only starting playback opens a player; pausing or skipping one that is closed does nothing.
        guard Self.running(a) || ["play", "playpause"].contains(action) else { return .stopped(a) }
        _ = try await ScriptHandler.call(Self.source(a), handler: "psyche_control",
                                         [action, "\(volume ?? 0)", shuffle.map { $0 ? "true" : "false" } ?? ""], app: Self.bundleIds[a]!)
        return try await read(a)
    }

    func call(_ handler: String, _ args: [Any]) async throws -> String? {
        try await ScriptHandler.call(Self.libraryScript, handler: handler, args, app: Self.bundleIds["music"]!)
    }

    public func searchLibrary(query: String, kind: String?, limit: Int) async throws -> [MusicItemRecord] {
        var items: [MusicItemRecord] = []
        let kinds = kind.map { [$0] } ?? MusicWave1.kinds
        let rows: (String) async throws -> [MusicTrackRow] = { only in
            ScriptRecords.parse(try await self.call("psyche_tracks", [query, only, "300"]), fields: 5).map {
                MusicTrackRow(persistentId: $0[0], name: $0[1], artist: $0[2], album: $0[3], albumArtist: $0[4])
            }
        }
        for k in kinds {
            switch k {
            case "track":
                items += try await rows("songs").map { MusicItemRecord(kind: "track", id: $0.persistentId, name: $0.name, artist: $0.artist, album: $0.album) }
            case "album": items += MusicWave1.group(try await rows("albums"), kind: "album")
            case "artist": items += MusicWave1.group(try await rows("artists"), kind: "artist")
            default:
                items += ScriptRecords.parse(try await call("psyche_playlists", [query]), fields: 3).map {
                    MusicItemRecord(kind: "playlist", id: $0[0], name: $0[1], trackCount: Int($0[2]))
                }
            }
        }
        return MusicWave1.rank(items, query: query, limit: limit)
    }

    public func play(kind: String, id: String, shuffle: Bool?) async throws -> NowPlayingRecord {
        let shuf = shuffle.map { $0 ? "true" : "false" } ?? ""
        switch kind {
        case "track":
            _ = try await call("psyche_play_track", [id])
        case "playlist":
            _ = try await call("psyche_play_playlist", [id, shuf])
        case "album":
            guard let (artist, album) = MusicWave1.parseAlbum(id) else { throw CapabilityError.invalidParams("not an album id from music.search_library", field: "id") }
            if try await call("psyche_play_set", ["album", artist, album, shuf]) == "empty" {
                throw CapabilityError(.notFound, reason: "music_not_found", "No tracks of \(album) in the library")
            }
        default:
            guard let artist = MusicWave1.parseArtist(id) else { throw CapabilityError.invalidParams("not an artist id from music.search_library", field: "id") }
            if try await call("psyche_play_set", ["artist", artist, "", shuf]) == "empty" {
                throw CapabilityError(.notFound, reason: "music_not_found", "No tracks by \(artist) in the library")
            }
        }
        return try await read("music")
    }
}
