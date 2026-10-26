import Foundation
import PsycheProtocol

// Music and Spotify wave 1 (docs/connectors/apple-apps-2026.md §4.6, U1–U2): pure pieces.

/// `AppleNowPlaying`.
public struct NowPlayingRecord: Codable, Sendable, Equatable {
    public struct Track: Codable, Sendable, Equatable {
        public var name: String
        public var artist: String
        public var album: String
        public var durationSeconds: Double?
        public var positionSeconds: Double?

        public init(name: String, artist: String, album: String, durationSeconds: Double?, positionSeconds: Double?) {
            self.name = name
            self.artist = artist
            self.album = album
            self.durationSeconds = durationSeconds
            self.positionSeconds = positionSeconds
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            try c.encode(artist, forKey: .artist)
            try c.encode(album, forKey: .album)
            try c.encode(durationSeconds, forKey: .durationSeconds)
            try c.encode(positionSeconds, forKey: .positionSeconds)
        }
    }

    public var app: String
    public var state: String
    public var track: Track?
    public var volume: Int?
    public var shuffle: Bool?

    public init(app: String, state: String, track: Track? = nil, volume: Int? = nil, shuffle: Bool? = nil) {
        self.app = app
        self.state = state
        self.track = track
        self.volume = volume
        self.shuffle = shuffle
    }

    public static func stopped(_ app: String) -> NowPlayingRecord { NowPlayingRecord(app: app, state: "stopped") }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(app, forKey: .app)
        try c.encode(state, forKey: .state)
        try c.encode(track, forKey: .track)
        try c.encode(volume, forKey: .volume)
        try c.encode(shuffle, forKey: .shuffle)
    }
}

/// `AppleMusicItem`.
public struct MusicItemRecord: Codable, Sendable, Equatable {
    public var kind: String
    public var id: String
    public var name: String
    public var artist: String?
    public var album: String?
    public var trackCount: Int?

    public init(kind: String, id: String, name: String, artist: String? = nil, album: String? = nil, trackCount: Int? = nil) {
        self.kind = kind
        self.id = id
        self.name = name
        self.artist = artist
        self.album = album
        self.trackCount = trackCount
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(artist, forKey: .artist)
        try c.encode(album, forKey: .album)
        try c.encode(trackCount, forKey: .trackCount)
    }
}

/// A library track as the search script returns it.
public struct MusicTrackRow: Sendable, Equatable {
    public var persistentId: String
    public var name: String
    public var artist: String
    public var album: String
    public var albumArtist: String

    public init(persistentId: String, name: String, artist: String, album: String, albumArtist: String) {
        self.persistentId = persistentId
        self.name = name
        self.artist = artist
        self.album = album
        self.albumArtist = albumArtist
    }
}

public enum MusicWave1 {
    public static let apps = ["music", "spotify"]
    public static let kinds = ["track", "album", "artist", "playlist"]
    public static let actions = ["play", "pause", "playpause", "next", "previous", "volume", "shuffle"]

    static var part: CharacterSet {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~ ")
        return s
    }

    static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: part) ?? s }

    /// `album/<artist>/<album>` and `artist/<artist>` (percent-encoded): Music has no ids for these.
    public static func albumId(artist: String, album: String) -> String { "album/\(enc(artist))/\(enc(album))" }
    public static func artistId(_ artist: String) -> String { "artist/\(enc(artist))" }

    public static func parseAlbum(_ id: String) -> (artist: String, album: String)? {
        let p = id.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 3, p[0] == "album", let a = p[1].removingPercentEncoding, let b = p[2].removingPercentEncoding, !b.isEmpty else { return nil }
        return (a, b)
    }

    public static func parseArtist(_ id: String) -> String? {
        let p = id.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 2, p[0] == "artist", let a = p[1].removingPercentEncoding, !a.isEmpty else { return nil }
        return a
    }

    /// Music persistent IDs are 16 hex digits.
    public static func isPersistentId(_ s: String) -> Bool { s.count == 16 && s.allSatisfy(\.isHexDigit) }

    /// Albums or artists from matching tracks, with their track counts.
    public static func group(_ rows: [MusicTrackRow], kind: String) -> [MusicItemRecord] {
        var order: [String] = []
        var items: [String: MusicItemRecord] = [:]
        for r in rows {
            let artist = r.albumArtist.isEmpty ? r.artist : r.albumArtist
            let item: MusicItemRecord
            if kind == "album" {
                guard !r.album.isEmpty else { continue }
                item = MusicItemRecord(kind: "album", id: albumId(artist: artist, album: r.album), name: r.album, artist: artist, trackCount: 0)
            } else {
                guard !artist.isEmpty else { continue }
                item = MusicItemRecord(kind: "artist", id: artistId(artist), name: artist, trackCount: 0)
            }
            if items[item.id] == nil {
                items[item.id] = item
                order.append(item.id)
            }
            let count = items[item.id]?.trackCount ?? 0
            items[item.id]?.trackCount = count + 1
        }
        return order.compactMap { items[$0] }
    }

    /// Exact name 3, prefix 2, contains 1; best first, then by name.
    public static func rank(_ xs: [MusicItemRecord], query: String, limit: Int) -> [MusicItemRecord] {
        let q = query.lowercased()
        func score(_ i: MusicItemRecord) -> Int {
            let n = i.name.lowercased()
            return n == q ? 3 : n.hasPrefix(q) ? 2 : n.contains(q) ? 1 : 0
        }
        let scored: [(MusicItemRecord, Int)] = xs.map { ($0, score($0)) }
        return scored.sorted { (a: (MusicItemRecord, Int), b: (MusicItemRecord, Int)) -> Bool in a.1 == b.1 ? a.0.name < b.0.name : a.1 > b.1 }
            .prefix(max(0, limit)).map { $0.0 }
    }

    /// Spotify reports durations in milliseconds, Music in seconds.
    public static func seconds(_ raw: String, app: String) -> Double? {
        guard let v = Double(raw.replacingOccurrences(of: ",", with: ".")), v >= 0 else { return nil }
        return app == "spotify" ? v / 1000 : v
    }
}
