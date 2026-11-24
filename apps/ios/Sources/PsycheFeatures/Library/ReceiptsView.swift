#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI

/// Receipts: what Psyche did on the owner's behalf (a payment, a sent email, a booking), newest first. The list
/// loads a page at a time: the next page comes when the owner reaches the end. Each row opens its fields (`receipts.get`).
struct ReceiptsView: View {
    @Environment(\.backend) private var backend

    var body: some View {
        ReceiptsList(store: backend)
    }
}

private struct ReceiptsList: View {
    @State private var model: PagedRows<ReceiptItem>

    init(store: any PsycheBackend) {
        _model = State(initialValue: PagedRows<ReceiptItem> { cursor in
            let page = try await store.receipts(cursor: cursor)
            return (page.receipts, page.nextCursor)
        })
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                switch model.phase {
                case .idle, .loading:
                    Color.clear.frame(height: 200)
                case .failed:
                    FailedNotice { Task { await model.reload() } }
                case .loaded(let receipts) where receipts.isEmpty:
                    Text("No receipts yet", bundle: .module).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    Text("Receipts appear here when Psyche acts for you.", bundle: .module)
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                case .loaded(let receipts):
                    PaperCard {
                        VStack(spacing: 0) {
                            ForEach(Array(receipts.enumerated()), id: \.element.id) { index, receipt in
                                if index > 0 { HairlineDivider().padding(.leading, 14) }
                                NavigationLink { ReceiptDetailView(id: receipt.id) } label: { ReceiptRow(receipt: receipt) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                    PagedRowsEnd(
                        moreFailed: model.moreFailed, nextCursor: model.nextCursor, loadingMore: model.loadingMore,
                        label: String(localized: "Loading more receipts", bundle: .module),
                        loadMore: { await model.loadMore() }, retryMore: { await model.retryMore() })
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .refreshable { await model.reload() }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle(String(localized: "Receipts", bundle: .module))
        .task { if model.phase.value == nil { await model.reload() } }
    }
}

private struct ReceiptRow: View {
    let receipt: ReceiptItem

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(receipt.summary.isEmpty ? receipt.kind : receipt.summary)
                    .font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    .lineLimit(2).multilineTextAlignment(.leading)
                Text(verbatim: [receipt.when, receipt.merchant].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                    .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
            }
            Spacer(minLength: 8)
            if let amount = receipt.amount {
                Text(verbatim: amount).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.text)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.rule)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// One receipt's fields: what, when, amount, merchant, status, and the task it came from.
struct ReceiptDetailView: View {
    let id: String
    @Environment(\.backend) private var backend
    @State private var receipt: ReceiptItem?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let receipt {
                    Text(verbatim: receipt.summary.isEmpty ? receipt.kind : receipt.summary)
                        .psycheTitle().foregroundStyle(PsycheColor.text)
                    PaperCard {
                        VStack(alignment: .leading, spacing: 0) {
                            ReceiptField(label: String(localized: "What", bundle: .module), value: receipt.kind)
                            HairlineDivider()
                            ReceiptField(label: String(localized: "When", bundle: .module), value: receipt.when)
                            if let amount = receipt.amount {
                                HairlineDivider()
                                ReceiptField(label: String(localized: "Amount", bundle: .module), value: amount)
                            }
                            if let merchant = receipt.merchant {
                                HairlineDivider()
                                ReceiptField(label: String(localized: "Merchant", bundle: .module), value: merchant)
                            }
                            HairlineDivider()
                            ReceiptField(label: String(localized: "Status", bundle: .module), value: receipt.outcome.label)
                            if let taskID = receipt.taskID {
                                HairlineDivider()
                                ReceiptField(label: String(localized: "Task", bundle: .module), value: taskID)
                            }
                            ForEach(receipt.references, id: \.key) { reference in
                                HairlineDivider()
                                ReceiptField(label: reference.key, value: reference.value)
                            }
                        }
                    }
                } else if failed {
                    FailedNotice { Task { await load() } }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle(String(localized: "Details", bundle: .module))
        .task { await load() }
    }

    private func load() async {
        do {
            receipt = try await backend.receipt(id: id)
            failed = false
        } catch {
            failed = true
        }
    }
}

private struct ReceiptField: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: label).font(.footnote).foregroundStyle(PsycheColor.muted)
            Text(verbatim: value).font(.psycheRow).foregroundStyle(PsycheColor.text).textSelection(.enabled)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ReceiptOutcome {
    var label: String {
        switch self {
        case .ok: String(localized: "Done", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .uncertain: String(localized: "Needs checking", bundle: .module)
        }
    }
}
#endif
