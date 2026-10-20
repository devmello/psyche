import Foundation
import SQLite3

/// A minimal read-only SQLite connection (J7). chat.db is opened with `mode=ro`, so the helper can
/// never write to Messages' database; statements bind parameters, never interpolate values.
public final class SQLiteReader: @unchecked Sendable {
    public enum Value: Equatable, Sendable {
        case null
        case int(Int64)
        case double(Double)
        case text(String)
        case blob(Data)

        public var int: Int64? { if case .int(let v) = self { return v }; return nil }
        public var text: String? { if case .text(let v) = self { return v }; return nil }
        public var blob: Data? { if case .blob(let v) = self { return v }; return nil }
    }

    public struct OpenError: Error, Sendable {
        /// SQLite result code; `SQLITE_CANTOPEN` / `SQLITE_AUTH` / `SQLITE_PERM` mean "no access".
        public var code: Int32
        public var message: String
        public var isPermission: Bool { code == SQLITE_CANTOPEN || code == SQLITE_PERM || code == SQLITE_AUTH }
        public var isBusy: Bool { code == SQLITE_BUSY || code == SQLITE_LOCKED }
    }

    public struct QueryError: Error, Sendable {
        public var code: Int32
        public var message: String
        public var isBusy: Bool { code == SQLITE_BUSY || code == SQLITE_LOCKED }
    }

    private var db: OpaquePointer?
    private let lock = NSLock()

    public init(path: String) throws {
        var url = URLComponents()
        url.scheme = "file"
        url.path = path
        url.queryItems = [URLQueryItem(name: "mode", value: "ro")]
        let uri = url.string ?? "file:\(path)?mode=ro"
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX
        let rc = sqlite3_open_v2(uri, &db, flags, nil)
        if rc != SQLITE_OK {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(db)
            db = nil
            throw OpenError(code: rc, message: msg)
        }
        sqlite3_busy_timeout(db, 2000)
        // A file the process may not read still "opens" lazily; touch the schema to surface EPERM now.
        do {
            _ = try query("SELECT count(*) FROM sqlite_master")
        } catch let e as QueryError {
            sqlite3_close(db)
            db = nil
            // Only access failures read as "no Full Disk Access"; busy / corrupt stay what they are.
            let access = e.code == SQLITE_CANTOPEN || e.code == SQLITE_PERM || e.code == SQLITE_AUTH
            throw OpenError(code: access ? SQLITE_CANTOPEN : e.code, message: e.message)
        }
    }

    deinit { sqlite3_close(db) }

    public func query(_ sql: String, _ args: [Value] = []) throws -> [[Value]] {
        lock.lock()
        defer { lock.unlock() }
        var stmt: OpaquePointer?
        var rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK else { throw QueryError(code: rc, message: errmsg) }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case .null: sqlite3_bind_null(stmt, idx)
            case .int(let v): sqlite3_bind_int64(stmt, idx, v)
            case .double(let v): sqlite3_bind_double(stmt, idx, v)
            case .text(let v): sqlite3_bind_text(stmt, idx, v, -1, transient)
            case .blob(let v): _ = v.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(v.count), transient) }
            }
        }
        var rows: [[Value]] = []
        while true {
            rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw QueryError(code: rc, message: errmsg) }
            let n = sqlite3_column_count(stmt)
            var row: [Value] = []
            row.reserveCapacity(Int(n))
            for c in 0..<n {
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row.append(.int(sqlite3_column_int64(stmt, c)))
                case SQLITE_FLOAT: row.append(.double(sqlite3_column_double(stmt, c)))
                case SQLITE_TEXT: row.append(.text(String(cString: sqlite3_column_text(stmt, c))))
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(stmt, c))
                    if let p = sqlite3_column_blob(stmt, c), count > 0 { row.append(.blob(Data(bytes: p, count: count))) } else { row.append(.blob(Data())) }
                default: row.append(.null)
                }
            }
            rows.append(row)
        }
        return rows
    }

    /// Column names of `table` (chat.db's schema differs across macOS versions).
    public func columns(_ table: String) throws -> Set<String> {
        Set(try query("SELECT name FROM pragma_table_info(?)", [.text(table)]).compactMap { $0.first?.text })
    }

    private var errmsg: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite error" }
}
