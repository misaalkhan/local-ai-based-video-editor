#!/bin/bash
# One-time setup for Local Studio on macOS. Safe to run again.
set -e
cd "$(dirname "$0")/.."
command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh"; exit 1; }
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list whisper-cpp >/dev/null 2>&1 || brew install whisper-cpp
mkdir -p models
[ -f models/ggml-large-v3-turbo-q5_0.bin ] || curl -L --fail -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
[ -f models/ggml-silero-v5.1.2.bin ] || curl -L --fail -o models/ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
# Places each word on the sound (English); without it word times come from whisper alone.
[ -f models/wav2vec2-base-960h.onnx ] || curl -L --fail -o models/wav2vec2-base-960h.onnx https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/onnx/model_quantized.onnx
# Speaker labels: who speaks when (pyannote segmentation 3.0 and a 3D-Speaker embedding model, 34 MB in all).
if [ ! -f models/pyannote-segmentation-3-0.onnx ]; then
  curl -L --fail -o models/pyannote-seg.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar xjf models/pyannote-seg.tar.bz2 -C models sherpa-onnx-pyannote-segmentation-3-0/model.onnx
  mv models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx models/pyannote-segmentation-3-0.onnx
  rm -rf models/pyannote-seg.tar.bz2 models/sherpa-onnx-pyannote-segmentation-3-0
fi
[ -f models/3dspeaker-campplus-zh-en.onnx ] || curl -L --fail -o models/3dspeaker-campplus-zh-en.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
# Voiceover voices (Kokoro v1.0, 132 MB download: English, Hindi, Spanish, French, Italian, Portuguese, Japanese, Chinese).
if [ ! -f models/kokoro-multi-lang-v1_0/model.int8.onnx ]; then
  curl -L --fail -o models/kokoro.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2
  tar xjf models/kokoro.tar.bz2 -C models && mv models/kokoro-int8-multi-lang-v1_0 models/kokoro-multi-lang-v1_0 && rm -f models/kokoro.tar.bz2
fi
# Noise reduction weights for ffmpeg's arnndn filter (public domain).
[ -f models/sh.rnnn ] || curl -L --fail -o models/sh.rnnn https://github.com/GregorR/rnnoise-models/raw/master/somnolent-hogwash-2018-09-01/sh.rnnn
[ -f models/wav2vec2-base-960h.vocab.json ] || curl -L --fail -o models/wav2vec2-base-960h.vocab.json https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/vocab.json
npm install
node scripts/make-sfx.ts
bash scripts/fonts.sh
bash scripts/music.sh
node scripts/sounds.ts
mkdir -p bin && swiftc -O server/native/facetrack.swift -o bin/facetrack 2>/dev/null || echo "Face tracking helper not built (needs Xcode command line tools)."
swiftc -O server/native/stabilize.swift -o bin/stabilize 2>/dev/null || echo "Stabilising helper not built (needs Xcode command line tools)."
swiftc -O server/native/objtrack.swift -o bin/objtrack 2>/dev/null || echo "Object tracking helper not built (needs Xcode command line tools)."
npx vite build
echo "Done. Start with: npm start"
