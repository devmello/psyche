import Darwin
import Foundation

/// Monotonic wall clock in seconds.
func now() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e9
}

func log(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

// MARK: - Memory

struct Footprint {
    let currentMB: Double
    let peakMB: Double
}

/// Physical footprint of this process (what Activity Monitor's "Memory" column shows).
func footprint() -> Footprint {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    guard kr == KERN_SUCCESS else { return Footprint(currentMB: -1, peakMB: -1) }
    return Footprint(
        currentMB: Double(info.phys_footprint) / 1_048_576,
        peakMB: Double(info.ledger_phys_footprint_peak) / 1_048_576)
}

// MARK: - WER

/// Lowercase, drop punctuation, split hyphens, keep apostrophes inside words.
func normalizeWords(_ text: String) -> [String] {
    var cleaned = ""
    for scalar in text.lowercased().folding(options: .diacriticInsensitive, locale: nil).unicodeScalars {
        if CharacterSet.alphanumerics.contains(scalar) || scalar == "'" || scalar == "’" {
            cleaned.unicodeScalars.append(scalar == "’" ? "'" : scalar)
        } else {
            cleaned.append(" ")
        }
    }
    return cleaned.split(separator: " ").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'")) }
        .filter { !$0.isEmpty }
}

private let ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
private let tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

/// "15" → ["fifteen"], so "15 minutes" and "fifteen minutes" both score as correct.
private func spellNumber(_ word: String) -> [String] {
    guard let n = Int(word), n >= 0, n < 1000 else { return [word] }
    var out: [String] = []
    var rest = n
    if rest >= 100 { out += [ones[rest / 100], "hundred"]; rest %= 100 }
    if rest >= 20 { out.append(tens[rest / 10]); rest %= 10; if rest > 0 { out.append(ones[rest]) } }
    else if rest > 0 || out.isEmpty { out.append(ones[rest]) }
    return out
}

func normalizeForScoring(_ text: String) -> [String] {
    normalizeWords(text).flatMap(spellNumber)
}

struct WerResult: Codable {
    let wer: Double
    let substitutions: Int
    let deletions: Int
    let insertions: Int
    let referenceWords: Int
}

func wordErrorRate(reference: String, hypothesis: String) -> WerResult {
    let r = normalizeForScoring(reference)
    let h = normalizeForScoring(hypothesis)
    // Levenshtein with backtrace counts.
    struct Cell { var cost: Int; var s: Int; var d: Int; var i: Int }
    var prev = (0...h.count).map { Cell(cost: $0, s: 0, d: 0, i: $0) }
    for x in 1...max(r.count, 1) where !r.isEmpty {
        var cur = [Cell(cost: x, s: 0, d: x, i: 0)]
        for y in 1...max(h.count, 1) where !h.isEmpty {
            let sub = prev[y - 1]
            let del = prev[y]
            let ins = cur[y - 1]
            if r[x - 1] == h[y - 1] {
                cur.append(sub)
                continue
            }
            let options = [
                Cell(cost: sub.cost + 1, s: sub.s + 1, d: sub.d, i: sub.i),
                Cell(cost: del.cost + 1, s: del.s, d: del.d + 1, i: del.i),
                Cell(cost: ins.cost + 1, s: ins.s, d: ins.d, i: ins.i + 1),
            ]
            cur.append(options.min { $0.cost < $1.cost }!)
        }
        prev = cur
    }
    let last = prev[h.count]
    return WerResult(
        wer: r.isEmpty ? 0 : Double(last.cost) / Double(r.count),
        substitutions: last.s, deletions: last.d, insertions: last.i, referenceWords: r.count)
}

/// How many occurrences of each custom-vocabulary term made it into the hypothesis.
func vocabularyHits(reference: String, hypothesis: String, terms: [String]) -> [String: String] {
    let refWords = normalizeWords(reference).joined(separator: " ")
    let hypWords = normalizeWords(hypothesis).joined(separator: " ")
    var out: [String: String] = [:]
    for term in terms {
        let t = normalizeWords(term).joined(separator: " ")
        let expected = refWords.components(separatedBy: t).count - 1
        let got = hypWords.components(separatedBy: t).count - 1
        out[term] = "\(min(got, expected))/\(expected)"
    }
    return out
}
