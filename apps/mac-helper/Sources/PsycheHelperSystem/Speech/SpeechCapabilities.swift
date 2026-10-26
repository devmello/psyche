import AVFAudio
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Speech

/// The `speech.*` capability group (feature Q1 engines; ADR-014, ADR-016; architecture §6).
public enum SpeechCapabilities {
    /// - Parameters:
    ///   - preflight: TCC preflight for microphone / speech recognition. Defaults to the live checks;
    ///     the integrator may pass the shared `permissions.*` preflight instead.
    ///   - registry: active streams (shared by transcribe / audio_push / stop).
    ///   - fileBackend: `speech.transcribe_file` audio and engine (default `AVAudioFile` + on-device engine).
    ///   - fileRoots: folders `speech.transcribe_file` may read (default: the granted folders and the Library).
    public static func make(
        preflight: (any PermissionPreflight)? = nil,
        registry: SpeechStreamRegistry = SpeechStreamRegistry(),
        log: HelperLog = HelperLog(),
        fileBackend: (any LongFormAudioBackend)? = nil,
        fileRoots: (@Sendable () -> FinderRoots)? = nil,
        synthesis: any SynthesisBackend = LiveSynthesisBackend(),
        timings: SpeechTimings = SpeechTimings(),
        transcriptionEngine: (@Sendable (TranscribeRequest) async throws -> any TranscriptionEngine)? = nil
    ) -> [any CapabilityHandler] {
        let preflight = preflight ?? SpeechPermissionPreflight()
        let fileBackend = fileBackend ?? LiveLongFormBackend(preflight: preflight)
        let fileRoots = fileRoots ?? { LongFormTranscription.roots() }
        let format = Schema.object(
            [
                "encoding": Schema.string("PCM sample encoding (little-endian, interleaved)", enum: PCMEncoding.allCases.map(\.rawValue)),
                "sampleRate": Schema.integer("Hz", min: PCMAudioFormat.sampleRateRange.lowerBound, max: PCMAudioFormat.sampleRateRange.upperBound),
                "channels": Schema.integer(min: PCMAudioFormat.channelRange.lowerBound, max: PCMAudioFormat.channelRange.upperBound),
            ], required: ["encoding", "sampleRate", "channels"], description: "Pushed audio format (source \"push\" only)")
        let streamId = Schema.string("Stream id: the invocationId of the speech.transcribe_stream call", maxLength: SpeechLimits.maxStreamIdLength)

        return [
            Capability(CapabilitySpec(
                name: "speech.transcribe_stream",
                description: "Transcribe speech on device from the microphone or pushed PCM, streaming speech.partial / speech.final events. Engine: SpeechAnalyzer (macOS 26+; DictationTranscriber with a vocabulary or preset short) or on-device SFSpeechRecognizer. The stream id is this invocation's id; end it with speech.stop.",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "source": Schema.string("Audio source (default microphone)", enum: SpeechSource.allCases.map(\.rawValue)),
                    "locale": Schema.string("BCP-47 language tag (default: the Mac's locale)", maxLength: 35),
                    "vocabulary": Schema.array(
                        Schema.string(maxLength: SpeechLimits.maxVocabularyEntryLength),
                        description: "Custom vocabulary (names, terms)", maxItems: SpeechLimits.maxVocabularyEntries),
                    "format": format,
                    "maxDurationMs": Schema.integer(
                        "Audio cap (default \(SpeechLimits.defaultMaxDurationMs))", min: SpeechLimits.minDurationMs, max: SpeechLimits.maxDurationMs),
                    "volatile": Schema.boolean("Stream volatile partial results (default true)"),
                    "preset": Schema.string("long (default: dictation, memos) or short (conversation turns: DictationTranscriber, short-form hint, frequent finalization)", enum: SpeechPreset.allCases.map(\.rawValue)),
                ]),
                streaming: true,
                // Checked per call: microphone for source "microphone", speechRecognition for the SFSpeech engine.
                permissions: []
            )) { ctx in
                try await SpeechTranscription.run(ctx, registry: registry, preflight: preflight, log: log, timings: timings, engineFactory: transcriptionEngine)
            },

            Capability(CapabilitySpec(
                name: "speech.transcribe_file",
                description: "Transcribe an audio file in a granted folder or the Library on device (up to 4 h), in chunks of about 10 minutes with overlap, streaming speech.progress events. Engine: SpeechAnalyzer (DictationTranscriber with a vocabulary) or on-device SFSpeechRecognizer. The transcript is untrusted: other people may be speaking.",
                sideEffect: .read,
                targetKind: .path,
                inputSchema: Schema.object([
                    "path": Schema.string("Absolute path of an audio file in a granted folder or the Library", maxLength: LongFormLimits.maxPathLength),
                    "locale": Schema.string("BCP-47 language tag (default: the Mac's locale)", maxLength: 35),
                    "vocabulary": Schema.array(
                        Schema.string(maxLength: SpeechLimits.maxVocabularyEntryLength),
                        description: "Custom vocabulary (names, terms)", maxItems: SpeechLimits.maxVocabularyEntries),
                    "maxDurationMs": Schema.integer(
                        "Refuse longer files (default and ceiling \(LongFormLimits.maxDurationMs))", min: SpeechLimits.minDurationMs, max: LongFormLimits.maxDurationMs),
                ], required: ["path"]),
                streaming: true,
                // speechRecognition is checked per chunk for the SFSpeech engine.
                permissions: []
            )) { ctx in
                try await LongFormTranscription.run(ctx, backend: fileBackend, roots: fileRoots(), log: log)
            },

            Capability(CapabilitySpec(
                name: "speech.audio_push",
                description: "Push a chunk of PCM audio (base64) into a speech.transcribe_stream started with source \"push\"; final: true ends the input.",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "streamId": streamId,
                    "data": Schema.string("Base64 PCM in the stream's format (≤ \(SpeechLimits.maxPushBytes) bytes decoded)", maxLength: (SpeechLimits.maxPushBytes + 2) / 3 * 4),
                    "final": Schema.boolean("No more audio follows"),
                ], required: ["streamId", "data"])
            )) { ctx in
                let p = try ctx.decode(AudioPushParams.self).validated()
                let buffered = try registry.push(streamId: p.streamId, audio: p.audio, final: p.final)
                return CapabilityOutput(["accepted": .int(p.audio.count), "bufferedBytes": .int(buffered), "final": .bool(p.final)])
            },

            Capability(CapabilitySpec(
                name: "speech.stop",
                description: "Stop a speech stream (microphone or push); it finalizes and its speech.transcribe_stream call returns the transcript.",
                sideEffect: .read,
                inputSchema: Schema.object(["streamId": streamId], required: ["streamId"])
            )) { ctx in
                let id = try ctx.decode(StreamIdParams.self).validated()
                try registry.stop(streamId: id)
                return CapabilityOutput(["stopped": true, "streamId": .string(id)])
            },

            Capability(CapabilitySpec(
                name: "speech.synthesize",
                description: "Synthesize speech on device with AVSpeechSynthesizer, streaming speech.audio PCM chunks to the caller (the helper never plays audio). speed (0.5–2× normal) wins over rate; utteranceId is echoed on every chunk. A synthesizer stays warm per voice between sentences. Personal Voice only with personalVoice: true and Personal Voice authorization; its output is for personal, non-commercial use.",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "text": Schema.string("Text to speak", maxLength: SpeechLimits.maxSynthesisTextLength),
                    "voice": Schema.string("Voice id from speech.voices", maxLength: SpeechLimits.maxVoiceIdLength),
                    "rate": Schema.number("0 (slowest) … 1 (fastest); 0.5 ≈ normal", min: 0, max: 1),
                    "speed": Schema.number("Multiplier of the voice's normal speed; wins over rate", min: SpeechRate.minSpeed, max: SpeechRate.maxSpeed),
                    "personalVoice": Schema.boolean("Opt in to the user's Personal Voice (default false)"),
                    "format": Schema.string("Output encoding (default pcm_s16le)", enum: PCMEncoding.allCases.map(\.rawValue)),
                    "utteranceId": Schema.string("Echoed on every speech.audio event", maxLength: SpeechLimits.maxUtteranceIdLength),
                ], required: ["text"]),
                streaming: true
            )) { ctx in
                let p = try ctx.decode(SynthesizeParams.self).validated()
                return try await SpeechSynthesis.run(p, backend: synthesis, timings: timings, emit: ctx.emit)
            },

            Capability(CapabilitySpec(
                name: "speech.prepare",
                description: "Keep a synthesizer warm for a voice (or the best installed voice for a language) so a conversation's first sentence starts fast: renders a short phrase that is thrown away, never played. It stays warm for keepWarmMs without use (default 120 s).",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "voice": Schema.string("Voice id from speech.voices", maxLength: SpeechLimits.maxVoiceIdLength),
                    "language": Schema.string("BCP-47 tag; picks premium, then enhanced, then default", maxLength: 35),
                    "keepWarmMs": Schema.integer("Default 120000", min: SpeechPrepareParams.keepWarmRange.lowerBound, max: SpeechPrepareParams.keepWarmRange.upperBound),
                ])
            )) { ctx in
                let p = try ctx.decode(SpeechPrepareParams.self).validated()
                let clock = ContinuousClock()
                let started = clock.now
                let voice = try await synthesis.prepare(voice: p.voice, language: p.language, keepWarmMs: p.keepWarmMs ?? SpeechPrepareParams.defaultKeepWarmMs)
                return CapabilityOutput(["voice": .string(voice.id), "prepared": true, "prepareMs": .int(elapsedMs(started, clock.now))])
            },

            Capability(CapabilitySpec(
                name: "speech.voices",
                description: "List installed speech synthesis voices {id, name, language, quality, personalVoice, installed}.",
                sideEffect: .read,
                inputSchema: Schema.object(["language": Schema.string("Filter by language prefix, e.g. en or en-GB", maxLength: 35)])
            )) { ctx in
                struct P: Decodable { var language: String? }
                let prefix = try ctx.decode(P.self).language?.lowercased().replacingOccurrences(of: "_", with: "-")
                let voices = AVSpeechSynthesisVoice.speechVoices()
                    .filter { v in prefix.map { v.language.lowercased().hasPrefix($0) } ?? true }
                    .sorted { ($0.language, $0.name) < ($1.language, $1.name) }
                return CapabilityOutput([
                    "voices": .array(voices.map(SpeechSynthesis.voiceJSON)),
                    "personalVoiceAuthorization": .string(SpeechSynthesis.personalVoiceStatus()),
                ])
            },

            Capability(CapabilitySpec(
                name: "speech.status",
                description: "Speech engines available on this Mac, OS gates, SpeechTranscriber locales, permission state and active streams.",
                sideEffect: .read,
                inputSchema: Schema.object(["locale": Schema.string("Locale to evaluate engines for (default: the Mac's locale)", maxLength: 35)])
            )) { ctx in
                struct P: Decodable { var locale: String? }
                let id = try SpeechValidation.locale(try ctx.decode(P.self).locale)
                return CapabilityOutput(await status(locale: id, registry: registry, timings: timings))
            },
        ]
    }

    static func status(locale id: String?, registry: SpeechStreamRegistry, timings: SpeechTimings) async -> JSONValue {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let requested = id.map { Locale(identifier: $0) } ?? Locale.current
        let probe = await SpeechTranscription.probe(requested)
        let defaultEngine = try? SpeechEngineSelector.select(os: os, vocabulary: [], availability: probe.availability)
        let vocabularyEngine = try? SpeechEngineSelector.select(os: os, vocabulary: ["x"], availability: probe.availability)
        let shortEngine = try? SpeechEngineSelector.select(os: os, vocabulary: [], availability: probe.availability, preset: .short)
        var o: [String: JSONValue] = [
            "os": .string("\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"),
            "gates": ["speechAnalyzer": .bool(SpeechEngineSelector.analyzerGateOpen(os)), "minimumMajorVersion": .int(SpeechEngineSelector.analyzerMinimumMajorVersion)],
            "locale": .string(requested.identifier(.bcp47)),
            "engines": [
                "speechAnalyzer": ["available": .bool(probe.availability.speechTranscriber)],
                "dictationTranscriber": ["available": .bool(probe.availability.dictationTranscriber)],
                "sfSpeech": ["available": .bool(probe.availability.sfSpeechOnDevice), "onDevice": true],
            ],
            "defaultEngine": defaultEngine.map { .string($0.rawValue) } ?? .null,
            "vocabularyEngine": vocabularyEngine.map { .string($0.rawValue) } ?? .null,
            "shortPresetEngine": shortEngine.map { .string($0.rawValue) } ?? .null,
            "permissions": [
                "microphone": .string(SpeechPermissionPreflight.microphoneStatus()),
                "speechRecognition": .string(SpeechPermissionPreflight.speechRecognitionStatus()),
                "personalVoice": .string(SpeechSynthesis.personalVoiceStatus()),
            ],
            "activeStreams": .int(registry.activeCount),
            "timings": timings.json,
            "microphoneBusy": .bool(registry.microphoneBusy),
        ]
        #if canImport(FoundationModels)  // macOS 26 SDK: see SpeechAnalyzerEngine.swift
        if #available(macOS 26.0, *) {
            let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
            let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }.sorted()
            o["speechTranscriberLocales"] = [
                "supported": .array(supported.map { .string($0) }),
                "installed": .array(installed.map { .string($0) }),
            ]
        }
        #endif
        return .object(o)
    }
}
