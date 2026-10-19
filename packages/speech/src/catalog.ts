import type { ModelSpec } from "./models.ts";

/**
 * Pinned model catalog. whisper.cpp sizes and SHA-256 are the Hugging Face LFS hashes of
 * `ggerganov/whisper.cpp` (SHA-1 cross-check: whisper.cpp `models/README.md`); Silero VAD from
 * `ggml-org/whisper-vad`. Verified 2026-10-19. RAM figures are whisper.cpp's README estimates.
 */
const WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

function whisper(name: string, sizeBytes: number, sha256: string, description: string): ModelSpec {
  return {
    id: `whisper-${name}`,
    engine: "whisper",
    file: `whisper/ggml-${name}.bin`,
    url: `${WHISPER}/ggml-${name}.bin`,
    sha256,
    sizeBytes,
    license: "MIT",
    description,
  };
}

export const WHISPER_CATALOG: readonly ModelSpec[] = [
  whisper(
    "tiny.en",
    77_704_715,
    "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    "English, ~273 MB RAM; fastest, rough on names",
  ),
  whisper(
    "tiny",
    77_691_713,
    "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    "Multilingual, ~273 MB RAM",
  ),
  whisper(
    "base.en",
    147_964_211,
    "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    "English, ~388 MB RAM; default for dictation on the server",
  ),
  whisper(
    "base",
    147_951_465,
    "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    "Multilingual, ~388 MB RAM",
  ),
  whisper(
    "small.en",
    487_614_201,
    "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    "English, ~852 MB RAM",
  ),
  whisper(
    "small",
    487_601_967,
    "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    "Multilingual, ~852 MB RAM",
  ),
  whisper(
    "large-v3-turbo-q5_0",
    574_041_195,
    "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    "Multilingual, best quality per byte; for voice notes and files, not live partials",
  ),
  whisper(
    "large-v3-turbo",
    1_624_555_275,
    "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    "Multilingual, ~3.9 GB RAM unquantized",
  ),
  {
    id: "vad-silero-v6.2.0",
    engine: "vad",
    file: "vad/ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    sizeBytes: 885_098,
    license: "MIT",
    description: "Silero VAD for whisper.cpp --vad (file transcription)",
  },
];

const KOKORO =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const KOKORO_VOICE_BYTES = 522_240;
/** Kokoro v1.0 English voice style files (510 × 256 float32 each). */
const KOKORO_VOICE_SHA256: readonly [string, string][] = [
  ["af_alloy", "c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45"],
  ["af_aoede", "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361"],
  ["af_bella", "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b"],
  ["af_heart", "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"],
  ["af_jessica", "a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8"],
  ["af_kore", "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e"],
  ["af_nicole", "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a"],
  ["af_nova", "18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f"],
  ["af_river", "00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30"],
  ["af_sarah", "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a"],
  ["af_sky", "4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9"],
  ["am_adam", "162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716"],
  ["am_echo", "3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3"],
  ["am_eric", "e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832"],
  ["am_fenrir", "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43"],
  ["am_liam", "52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade"],
  ["am_michael", "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1"],
  ["am_onyx", "da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6"],
  ["am_puck", "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0"],
  ["am_santa", "61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a"],
  ["bf_alice", "08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573"],
  ["bf_emma", "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73"],
  ["bf_isabella", "3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f"],
  ["bf_lily", "5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335"],
  ["bm_daniel", "6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8"],
  ["bm_fable", "f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1"],
  ["bm_george", "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc"],
  ["bm_lewis", "b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97"],
];

export const KOKORO_CATALOG: readonly ModelSpec[] = [
  {
    id: "kokoro-q8",
    engine: "kokoro",
    file: "kokoro/model_quantized.onnx",
    url: `${KOKORO}/onnx/model_quantized.onnx`,
    sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
    sizeBytes: 92_361_116,
    license: "Apache-2.0",
    description: "Kokoro-82M v1.0, 8-bit; RTF ~0.5 and ~110–220 MB RSS on an M-series CPU",
  },
  {
    id: "kokoro-tokenizer",
    engine: "kokoro",
    file: "kokoro/tokenizer.json",
    url: `${KOKORO}/tokenizer.json`,
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    sizeBytes: 3_497,
    license: "Apache-2.0",
    description: "Kokoro phoneme vocabulary",
  },
  ...KOKORO_VOICE_SHA256.map(([voice, sha256]) => ({
    id: `kokoro-voice-${voice}`,
    engine: "kokoro",
    file: `kokoro/voices/${voice}.bin`,
    url: `${KOKORO}/voices/${voice}.bin`,
    sha256,
    sizeBytes: KOKORO_VOICE_BYTES,
    license: "Apache-2.0",
  })),
];

export const DEFAULT_WHISPER_MODEL = "whisper-base.en";

export const MODEL_CATALOG: readonly ModelSpec[] = [...WHISPER_CATALOG, ...KOKORO_CATALOG];
export const DEFAULT_KOKORO_MODEL = "kokoro-q8";
