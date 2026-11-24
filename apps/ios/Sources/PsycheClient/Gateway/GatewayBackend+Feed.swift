import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Feed and Ideas over `feed.list/feedback` and `ideas.list/accept/dismiss`. Read by name, so a new field
// or a new post kind never breaks the phone.
extension GatewayBackend {
    public func feed() async throws -> FeedSnapshot {
        let result = try await call("feed.list", .obj(["limit": .number(30)]))
        return FeedSnapshot(
            cards: (result["posts"]?.array ?? []).compactMap(Self.feedCard(from:)),
            nextBriefAt: WireFormat.date(result["nextBriefAt"]?.string))
    }


    /// `feed.generate` calls a model, so it gets far longer than a read.
    static let generateTimeout: Duration = .seconds(180)

    public func generateFeed() async throws -> [FeedCard] {
        let result = try await call(
            "feed.generate", .obj([:]), key: "feed-generate-\(UUID().uuidString)", timeout: Self.generateTimeout)
        return (result["posts"]?.array ?? []).compactMap(Self.feedCard(from:))
    }

    public func setFeedback(postID: String
, _ feedback: FeedFeedback?) async throws {
        _ = try await call(
            "feed.feedback", .obj(["postId": .string(postID), "feedback": feedback.map { .string($0.rawValue) } ?? .null]),
            key: "feed-\(postID)-\(feedback?.rawValue ?? "clear")")
    }

    public func ideas() async throws -> [IdeaItem] {
        let result = try await call("ideas.list", .obj(["limit": .number(30)]))
        return (result["ideas"]?.array ?? []).compactMap(Self.idea(from:))
    }

    public func acceptIdea(id: String) async throws {
        _ = try await call("ideas.accept", .obj(["ideaId": .string(id)]), key: "idea-accept-\(id)")
    }

    public func dismissIdea(id: String, reason: IdeaDismissReason) async throws {
        _ = try await call("ideas.dismiss", .obj(["ideaId": .string(id), "reason": .string(reason.rawValue)]), key: "idea-dismiss-\(id)")
    }

    // MARK: - Mapping

    static func feedCard(from post: JSONValue) -> FeedCard? {
        guard let id = post["id"]?.string, let title = post["title"]?.string else { return nil }
        let sources: [FeedSource] = (post["citations"]?.array ?? []).compactMap { citation in
            guard let url = citation["url"]?.string, !url.isEmpty else { return nil }
            return FeedSource(title: citation["title"]?.string ?? citation["source"]?.string ?? url, url: url)
        }
        return FeedCard(
            id: id, title: title, body: post["bodyMd"]?.string ?? "", sources: sources,
            createdAt: WireFormat.date(post["createdAt"]?.string),
            // An unknown feedback value reads as none rather than failing the card.
            feedback: post["feedback"]?.string.flatMap(FeedFeedback.init(rawValue:)))
    }

    static func idea(from wire: JSONValue) -> IdeaItem? {
        guard let id = wire["id"]?.string, let title = wire["title"]?.string else { return nil }
        // Only proposed ideas are decisions; the default listing already filters, this keeps a stray one out.
        if let status = wire["status"]?.string, status != "proposed" { return nil }
        return IdeaItem(
            id: id, kind: wire["kind"]?.string ?? "task", title: title, body: wire["bodyMd"]?.string ?? "",
            effort: wire["effort"]?.string ?? "", createdAt: WireFormat.date(wire["createdAt"]?.string))
    }
}
