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

export const MODEL_CATALOG: readonly ModelSpec[] = [
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

export const DEFAULT_WHISPER_MODEL = "whisper-base.en";
