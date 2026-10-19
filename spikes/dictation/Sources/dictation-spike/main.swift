@preconcurrency import AVFoundation
import Foundation
import Speech

// dictation-spike — spike 03. Usage:
//   swift tts.swift script.txt audio/raw.caf com.apple.siri.natural.Nora 0.45
//   dictation-spike make-audio --speech audio/raw.caf --out audio/ [--snr 10]
//   dictation-spike auth [--request]
//   dictation-spike asset --locale fr-FR [--release]
//   dictation-spike run --engine <id> (--input file.wav | --mic [--seconds N]) [--script script.txt] [--out result.json]
// Engines: speech, speech-fast, speech-vocab, dictation, dictation-short, dictation-vocab,
//          parakeet-eou (320 ms), parakeet-eou-160, parakeet-tdt,
//          whisper-base, whisper-small, whisper-base-vocab, whisper-small-vocab

/// The agent name and three contact names from the script, used as custom vocabulary.
let vocabulary = ["Ondine", "Ngozi Adeyemi", "Kaveh Farrokhzad", "Marisol Echeverria"]

struct Args {
    private var values: [String: String] = [:]
    private var flags: Set<String> = []
    let command: String

    init(_ argv: [String]) {
        command = argv.first ?? "help"
        var i = 1
        while i < argv.count {
            let key = argv[i]
            if key.hasPrefix("--"), i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                values[key] = argv[i + 1]
                i += 2
            } else {
                flags.insert(key)
                i += 1
            }
        }
    }

    subscript(_ key: String) -> String? { values[key] }
    func has(_ flag: String) -> Bool { flags.contains(flag) || values[flag] != nil }
}

struct SessionResult: Codable {
    var label: String
    var audioSeconds: Double
    /// key-down → first non-empty partial.
    var firstPartialFromKeyDown: Double?
    /// speech onset (first loud buffer delivered) → first non-empty partial.
    var firstPartialFromSpeech: Double?
    var firstPartialText: String?
    var partialCount: Int
    /// Every hypothesis change, in seconds after key-down.
    var updateTimes: [Double]?
    /// First 80 characters of each hypothesis, aligned with updateTimes (to spot hallucinated partials).
    var updateTexts: [String]?
    /// Mean gap between hypothesis updates while audio was flowing.
    var meanUpdateInterval: Double?
    /// key-up (last buffer delivered) → final transcript returned.
    var finalLatency: Double
    var transcript: String
    var wer: WerResult?
    var vocabularyHits: [String: String]?
}

struct RunResult: Codable {
    var engine: String
    var input: String
    var os: String
    var machine: String
    var prepareSeconds: Double
    var footprintAfterPrepareMB: Double
    var peakFootprintMB: Double
    var notes: [String]
    var sessions: [SessionResult]
    var error: String?
}

/// Records partial timestamps from whichever thread the engine calls back on.
final class UpdateLog: @unchecked Sendable {
    private let lock = NSLock()
    private var times: [Double] = []
    private var texts: [String] = []
    private var last = ""
    private(set) var firstText: String?
    let echo: Bool
    init(echo: Bool) { self.echo = echo }

    func record(_ text: String) {
        let t = now()
        lock.lock()
        defer { lock.unlock() }
        guard !text.isEmpty, text != last else { return }
        last = text
        if firstText == nil { firstText = text }
        times.append(t)
        texts.append(String(text.prefix(80)))
        if echo { log(String(format: "  [%7.3f] … %@", t, String(text.suffix(110)))) }
    }

    var textSnapshot: [String] {
        lock.lock()
        defer { lock.unlock() }
        return texts
    }

    var snapshot: [Double] {
        lock.lock()
        defer { lock.unlock() }
        return times
    }
}

@MainActor
func runSession(engine: DictationEngine, source: AudioSource, audioSeconds: Double, label: String,
                reference: String?, echo: Bool) async throws -> SessionResult {
    let updates = UpdateLog(echo: echo)
    try await engine.begin(onUpdate: { updates.record($0) })

    let (stream, continuation) = AsyncStream<AVAudioPCMBuffer>.makeStream()
    // The consumer drains buffers into the engine so a slow engine queues up instead of slowing capture.
    let consumer = Task { @MainActor in
        for await buffer in stream { try await engine.feed(buffer) }
    }
    let keyDown = now()
    nonisolated(unsafe) var speechAt: Double?
    nonisolated(unsafe) var delivered = 0
    try await source.run(
        deliver: { delivered += Int($0.frameLength); continuation.yield($0) },
        speechStarted: { speechAt = now() })
    continuation.finish()
    let keyUp = now()
    try await consumer.value
    let transcript = try await engine.end()
    let finalAt = now()

    let times = updates.snapshot.filter { $0 <= keyUp }
    let first = updates.snapshot.first
    var result = SessionResult(
        label: label,
        audioSeconds: audioSeconds > 0 ? audioSeconds : Double(delivered) / sampleRate,
        firstPartialFromKeyDown: first.map { $0 - keyDown },
        firstPartialFromSpeech: first.flatMap { f in speechAt.map { f - $0 } },
        firstPartialText: updates.firstText,
        partialCount: updates.snapshot.count,
        updateTimes: updates.snapshot.map { $0 - keyDown },
        updateTexts: updates.textSnapshot,
        meanUpdateInterval: times.count > 1 ? (times.last! - times.first!) / Double(times.count - 1) : nil,
        finalLatency: finalAt - keyUp,
        transcript: transcript)
    if let reference {
        result.wer = wordErrorRate(reference: reference, hypothesis: transcript)
        result.vocabularyHits = vocabularyHits(
            reference: reference, hypothesis: transcript, terms: vocabulary.flatMap { $0.split(separator: " ").map(String.init) })
    }
    return result
}

func machineName() -> String {
    var size = 0
    sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
    var buf = [CChar](repeating: 0, count: size)
    sysctlbyname("machdep.cpu.brand_string", &buf, &size, nil, 0)
    let mem = ProcessInfo.processInfo.physicalMemory / 1_073_741_824
    return "\(String(cString: buf)) \(mem) GB"
}

@MainActor
func run(_ args: Args) async throws {
    guard let engineID = args["--engine"] else { throw SpikeError.message("--engine required") }
    let reference = try args["--script"].map { try String(contentsOfFile: $0, encoding: .utf8) }
    let echo = args.has("--verbose")
    var result = RunResult(
        engine: engineID, input: args["--input"] ?? "mic",
        os: ProcessInfo.processInfo.operatingSystemVersionString, machine: machineName(),
        prepareSeconds: 0, footprintAfterPrepareMB: 0, peakFootprintMB: 0, notes: [], sessions: [])

    let engine = try makeEngine(engineID)
    do {
        let t = now()
        try await engine.prepare(vocabulary: vocabulary)
        result.prepareSeconds = now() - t
        result.footprintAfterPrepareMB = footprint().currentMB
        log(String(format: "%@ prepared in %.2f s, footprint %.0f MB", engineID, result.prepareSeconds, result.footprintAfterPrepareMB))

        if let input = args["--input"] {
            let samples = try readMono16k(URL(fileURLWithPath: input))
            // Warm-up utterance: the first 4 s, as the first push-to-talk after launch would be.
            if !args.has("--no-warmup") {
                let warm = Array(samples.prefix(64_000))
                let s = try await runSession(engine: engine, source: FileSource(samples: warm),
                                             audioSeconds: Double(warm.count) / sampleRate, label: "first utterance (4 s)",
                                             reference: nil, echo: echo)
                result.sessions.append(s)
                log("first utterance: \(s.transcript)")
            }
            let s = try await runSession(engine: engine, source: FileSource(samples: samples),
                                         audioSeconds: Double(samples.count) / sampleRate, label: "full script (warm)",
                                         reference: reference, echo: echo)
            result.sessions.append(s)
        } else {
            let seconds = args["--seconds"].flatMap(Double.init)
            let s = try await runSession(engine: engine, source: MicSource(seconds: seconds), audioSeconds: 0,
                                         label: "microphone", reference: reference, echo: true)
            result.sessions.append(s)
        }
    } catch {
        result.error = "\(error)"
        log("ERROR: \(error)")
    }
    result.notes = engine.notes
    result.peakFootprintMB = footprint().peakMB

    for s in result.sessions {
        log(String(format: "%@ — first partial %@ s after speech, final %.3f s after key-up, WER %@",
                   s.label, s.firstPartialFromSpeech.map { String(format: "%.3f", $0) } ?? "–", s.finalLatency,
                   s.wer.map { String(format: "%.1f%%", $0.wer * 100) } ?? "–"))
        log("  » \(s.transcript)")
    }
    log(String(format: "peak footprint %.0f MB", result.peakFootprintMB))

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(result)
    if let out = args["--out"] {
        try data.write(to: URL(fileURLWithPath: out))
    } else {
        print(String(decoding: data, as: UTF8.self))
    }
    if result.error != nil { exit(2) }
}

@MainActor
func makeAudio(_ args: Args) async throws {
    guard let speechPath = args["--speech"], let outDir = args["--out"] else {
        throw SpikeError.message("--speech and --out required")
    }
    let speech = padSpeech(try readMono16k(URL(fileURLWithPath: speechPath)))
    let snr = Float(args["--snr"] ?? "10") ?? 10
    let dir = URL(fileURLWithPath: outDir)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try writeWav(speech, to: dir.appendingPathComponent("clean.wav"))
    try writeWav(addNoiseFloor(speech, dBFS: -60), to: dir.appendingPathComponent("quiet.wav"))
    try writeWav(mixMusic(into: addNoiseFloor(speech, dBFS: -60), snrDB: snr), to: dir.appendingPathComponent("music.wav"))
    log(String(format: "wrote clean.wav, quiet.wav (-60 dBFS floor) and music.wav (%.1f s, music at %.0f dB SNR)",
               Double(speech.count) / sampleRate, snr))
}

@MainActor
func auth(_ args: Args) async {
    print("microphone:", AVCaptureDevice.authorizationStatus(for: .audio).rawValue, "(0 notDetermined, 1 restricted, 2 denied, 3 authorized)")
    print("speech recognition:", SFSpeechRecognizer.authorizationStatus().rawValue, "(0 notDetermined, 1 denied, 2 restricted, 3 authorized)")
    if args.has("--request") {
        let s = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        print("speech recognition after request:", s.rawValue)
    }
    if #available(macOS 26, *) {
        print("SpeechTranscriber.isAvailable:", SpeechTranscriber.isAvailable)
        let st = await SpeechTranscriber.supportedLocales
        let si = await SpeechTranscriber.installedLocales
        let dt = await DictationTranscriber.supportedLocales
        let di = await DictationTranscriber.installedLocales
        print("SpeechTranscriber locales: \(st.count) supported, installed: \(si.map(\.identifier))")
        print("DictationTranscriber locales: \(dt.count) supported, installed: \(di.map(\.identifier))")
        let locale = Locale(identifier: "en-US")
        let modules: [(String, any SpeechModule)] = [
            ("SpeechTranscriber", SpeechTranscriber(locale: locale, preset: .progressiveTranscription)),
            ("DictationTranscriber", DictationTranscriber(locale: locale, preset: .progressiveLongDictation)),
        ]
        for (name, m) in modules {
            print("\(name) en-US asset status:", await AssetInventory.status(forModules: [m]))
        }
        print("reserved locales:", await AssetInventory.reservedLocales.map(\.identifier), "max", AssetInventory.maximumReservedLocales)
        print("SpeechTranscriber supported:", st.map(\.identifier).sorted().joined(separator: " "))
    }
}

/// Times an `AssetInventory` download of a locale that is not on disk yet, then releases the reservation.
@MainActor
func asset(_ args: Args) async throws {
    guard #available(macOS 26, *) else { throw SpikeError.message("needs macOS 26") }
    let wanted = Locale(identifier: args["--locale"] ?? "fr-FR")
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
        throw SpikeError.message("unsupported locale")
    }
    let module = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    print("before:", await AssetInventory.status(forModules: [module]), "reserved:", await AssetInventory.reservedLocales.map(\.identifier))
    let t = now()
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        let progress = request.progress
        let observer = progress.observe(\.fractionCompleted) { p, _ in
            log(String(format: "  %.0f%% (%lld / %lld)", p.fractionCompleted * 100, p.completedUnitCount, p.totalUnitCount))
        }
        try await request.downloadAndInstall()
        observer.invalidate()
        print(String(format: "downloadAndInstall: %.1f s, progress total units %lld", now() - t, progress.totalUnitCount))
    } else {
        print("no installation request needed")
    }
    print("after:", await AssetInventory.status(forModules: [module]), "reserved:", await AssetInventory.reservedLocales.map(\.identifier))
    if args.has("--release") {
        print("released:", await AssetInventory.release(reservedLocale: locale))
    }
}

let args = Args(Array(CommandLine.arguments.dropFirst()))
Task { @MainActor in
    do {
        switch args.command {
        case "run": try await run(args)
        case "make-audio": try await makeAudio(args)
        case "auth": await auth(args)
        case "asset": try await asset(args)
        case "voices":
            for v in AVSpeechSynthesisVoice.speechVoices() where v.language.hasPrefix("en") { print(v.quality.rawValue, v.identifier) }
        default:
            log("commands: run, make-audio, auth (see the header of main.swift)")
        }
        exit(0)
    } catch {
        log("ERROR: \(error)")
        exit(1)
    }
}
RunLoop.main.run()
