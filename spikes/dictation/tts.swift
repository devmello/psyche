// Synthesizes the fixed script to a file. Usage: swift tts.swift script.txt out.caf <voice-identifier> [rate]
// Run interpreted: the Siri "natural" voices are listed for the swift interpreter but not for the
// compiled dictation-spike binary. Zero-length buffers arrive between paragraphs, so stop on 5 s of idle.
import AVFoundation
let text = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8).replacingOccurrences(of: "\n\n", with: "\n")
let out = URL(fileURLWithPath: CommandLine.arguments[2])
let voiceID = CommandLine.arguments[3]
let synth = AVSpeechSynthesizer()
let u = AVSpeechUtterance(string: text)
if CommandLine.arguments.count > 4 { u.rate = Float(CommandLine.arguments[4])! }
u.voice = AVSpeechSynthesisVoice.speechVoices().first { $0.identifier == voiceID }
print("voice:", u.voice?.identifier ?? "nil")
var file: AVAudioFile?
var last = Date()
var zeros = 0
synth.write(u) { buf in
  guard let pcm = buf as? AVAudioPCMBuffer else { return }
  last = Date(); if pcm.frameLength == 0 { zeros += 1; return }
  if file == nil { file = try! AVAudioFile(forWriting: out, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved) }
  try! file!.write(from: pcm)
}
while Date().timeIntervalSince(last) < 5 { RunLoop.main.run(until: Date().addingTimeInterval(0.2)) }
print("done frames", file?.length ?? 0, "zero buffers", zeros)
